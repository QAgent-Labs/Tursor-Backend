import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { withTrace } from '../lib/trace';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from '../tursor-ai/tursor-ai-runtime.service';
import { ContextService } from '../context/context.service';
import { CdpRunnerService } from '../cdp/cdp-runner.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import type {
  WorkspaceSupabaseBucketConfig,
  WorkspaceSupabaseConfig,
} from '../context/workspace-config.types';
import { WebsocketGateway } from './websocket.gateway';
import { demoCdpSteps, type CdpStepDefinition } from '../cdp/cdp-step.types';

function compactStatusMessage(message: string): string {
  const text = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) {
    return '';
  }
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}

/** Local date and time for run folder names, e.g. 2026-10-25_14-03-22. */
export function runStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Who and what a single browser run belongs to. */
export type RunContext = {
  conversationId: string | null;
  caseId: string | null;
  suiteId: string | null;
  batchId: string | null;
};

export type CaseRunItem = {
  caseId: string;
  suiteId: string | null;
  steps: CdpStepDefinition[];
  /** Readable folder name; screenshots go to runs/{runFolder}/ */
  runFolder: string;
};

export type RunOutcome = {
  testRunId: string | null;
  status: 'passed' | 'failure';
  statusMessage: string;
  failedStep: string;
  screenshots: string[];
};

/** Persists runs; supplied by the chat layer so this service stays storage-free. */
export type RunRecorder = {
  start(context: RunContext & { runFolder: string }): Promise<string | null>;
  finish(context: RunContext, outcome: RunOutcome): Promise<void>;
};

type ContextErrorSink = (code: string, message: string) => void;

type Preflight = {
  workspacePath: string;
  frontendPort: number;
  bucket: WorkspaceSupabaseBucketConfig;
};

export class RunOrchestratorService {
  private readonly contextErrorSink: ContextErrorSink = (code, message) =>
    this.gateway.emitContextError(code, message);
  private readonly logger = createLogger('RunOrchestratorService');
  private building = false;
  private cdpRunning = false;
  private embedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEmbedPath: string | null = null;
  private embedAgainAfterBuild = false;
  private recorder: RunRecorder | null = null;

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    private readonly tursorAiRuntime: TursorAiRuntimeService,
    private readonly tursorAi: TursorAiClient,
    private readonly cdpRunner: CdpRunnerService,
    private readonly gateway: WebsocketGateway,
  ) {}

  setRunRecorder(recorder: RunRecorder): void {
    this.recorder = recorder;
  }

  isCdpRunning(): boolean {
    return this.cdpRunning;
  }

  validateOnly(): { ok: boolean; error?: string } {
    const path = this.contextService.getWorkspacePath();
    if (!path) {
      return {
        ok: false,
        error: 'No workspace path set. Connect from the extension.',
      };
    }
    const result = this.validator.validate(path);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true };
  }

  scheduleIncrementalEmbed(changedPath?: string): void {
    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      return;
    }

    if (changedPath) {
      const normalized = changedPath.replace(/\\/g, '/');
      const workspaceRoot = workspacePath.replace(/\\/g, '/');
      if (
        !normalized.startsWith(`${workspaceRoot}/`) &&
        normalized !== workspaceRoot
      ) {
        return;
      }
      // Tursor's own folder (index, screenshots, saved reports, config) is not app code.
      if (normalized.includes('/.tursor/') || normalized.endsWith('/.tursor')) {
        return;
      }
      this.pendingEmbedPath = changedPath;
    }

    if (this.embedDebounceTimer) {
      clearTimeout(this.embedDebounceTimer);
    }

    this.embedDebounceTimer = setTimeout(() => {
      this.embedDebounceTimer = null;
      const pathHint = this.pendingEmbedPath;
      this.pendingEmbedPath = null;
      const name = pathHint ? pathHint.split(/[\\/]/).pop() : '';
      void withTrace(
        'context',
        name ? `Re-index · ${name}` : 'Re-index after change',
        () =>
          this.runEmbedPipeline({
            trigger: 'file_change',
            changedPath: pathHint ?? undefined,
          }),
      );
    }, 1500);
  }

  private validateWorkspaceOrEmitError(
    workspacePath: string,
    onError: ContextErrorSink = this.contextErrorSink,
  ): { ok: true; supabase: WorkspaceSupabaseConfig } | { ok: false } {
    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message: 'Validating local .tursor/config.json…',
      meta: { workspacePath },
    });

    const local = this.validator.validate(workspacePath);
    if (!local.ok) {
      onError('missing_tursor_config', local.error);
      return { ok: false };
    }

    this.gateway.emitRunLog({
      category: 'context',
      level: 'success',
      message:
        'Local workspace config validation passed (supabase settings loaded).',
    });
    return { ok: true, supabase: local.supabase };
  }

  private async ensureTursorAiReady(
    onError: ContextErrorSink = this.contextErrorSink,
  ): Promise<boolean> {
    if (await this.tursorAiRuntime.refresh()) {
      return true;
    }

    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message: 'Tursor-AI is not running — starting via `tursorAI start`…',
    });

    if (await this.tursorAiRuntime.tryStartViaCli()) {
      this.gateway.emitRunLog({
        category: 'context',
        level: 'success',
        message: 'Tursor-AI started and is reachable.',
      });
      return true;
    }

    onError(
      'tursor_ai_unreachable',
      'Tursor-AI is not reachable. Run `tursorAI start` or re-run Tursor install (Python 3.10+ required).',
    );
    return false;
  }

  private async buildFlowMap(
    workspacePath: string,
    needed: boolean,
    notify: boolean,
  ): Promise<void> {
    if (!needed) {
      return;
    }
    if (notify) {
      this.gateway.emitFlowMapBuilding();
    }
    try {
      const result = await this.tursorAi.buildFlowMap(workspacePath);
      const partial = result.failedBatches > 0;
      this.gateway.emitRunLog({
        category: 'context',
        level: result.skipped || partial ? 'warn' : 'success',
        message: result.skipped
          ? 'No routes were found, so the flow map is empty. Chat will use the code chunks alone.'
          : partial
            ? `Flow map ready from the code — ${result.screens} screens, ${result.reachable} reachable. ` +
              `${result.screens - result.described} screen(s) have no model-written labels because ` +
              `${result.failedBatches} model call(s) failed; they will be retried on the next build.`
            : `Flow map ready — ${result.screens} screens, ${result.reachable} reachable from the first page.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Flow map failed: ${message}`);
      this.gateway.emitRunLog({
        category: 'context',
        level: 'warn',
        message: `Flow map was not written. Chat will use the code chunks alone. ${message}`,
      });
    }
  }

  private async runEmbedPipeline(options?: {
    trigger?: 'initial' | 'file_change' | 'manual';
    changedPath?: string;
  }): Promise<boolean> {
    if (this.building) {
      if (options?.trigger === 'file_change') {
        // Pick the change up once the current build ends instead of dropping it.
        this.embedAgainAfterBuild = true;
        if (options.changedPath) {
          this.pendingEmbedPath = options.changedPath;
        }
      }
      this.gateway.emitRunLog({
        category: 'context',
        level: 'warn',
        message:
          options?.trigger === 'file_change'
            ? 'Context pipeline in progress — this change will be indexed when it finishes.'
            : 'Context pipeline already in progress — skipping duplicate run.',
      });
      return false;
    }

    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      this.gateway.emitContextError(
        'no_workspace',
        'Workspace path is not set.',
      );
      return false;
    }

    this.building = true;
    const startedAt = Date.now();
    const trigger = options?.trigger ?? 'manual';
    // With an index already in place, an update runs in the background: chat keeps
    // using the current index (Tursor-AI swaps files in whole) and is never blocked.
    // Only the first build, or an explicit revalidation, makes chat wait.
    const background =
      trigger !== 'manual' && this.contextService.isContextReady();
    const onError: ContextErrorSink = background
      ? (code, message) =>
          this.gateway.emitRunLog({
            category: 'context',
            level: 'warn',
            message: `Background code update failed; chat keeps using the previous index. ${message}`,
            meta: { code },
          })
      : this.contextErrorSink;
    this.contextService.setBuilding(true);
    if (background) {
      this.gateway.emitContextUpdating();
    } else {
      this.contextService.resetContextReady();
      this.gateway.emitContextBuilding();
    }

    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message:
        trigger === 'file_change'
          ? `Updating code context after file change${options?.changedPath ? `: ${options.changedPath}` : ''}.`
          : `Building code context for workspace: ${workspacePath}`,
      meta: {
        workspacePath,
        trigger,
        changedPath: options?.changedPath ?? null,
      },
    });

    try {
      const validated = this.validateWorkspaceOrEmitError(
        workspacePath,
        onError,
      );
      if (!validated.ok) {
        return false;
      }

      if (!(await this.ensureTursorAiReady(onError))) {
        return false;
      }

      await this.tursorAi.ensureReady();

      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: 'Validating workspace with Tursor-AI…',
        meta: { workspacePath },
      });

      const aiValidate = await this.tursorAi.validate(workspacePath);
      if (!aiValidate.ok) {
        onError(
          'tursor_ai_validate',
          aiValidate.error ?? 'Tursor-AI validation failed.',
        );
        return false;
      }

      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: 'Creating workspace embeddings (incremental when possible)…',
        meta: { workspacePath },
      });

      const embedResult = await this.tursorAi.embed(workspacePath);
      await this.buildFlowMap(
        workspacePath,
        embedResult.flow_map_needed === true,
        !background,
      );

      this.contextService.markContextReady({
        embeddingsDir: embedResult.embeddings_dir,
        filesIndexed: embedResult.files_indexed,
        chunksIndexed: embedResult.chunks_indexed,
        model: embedResult.model,
      });

      this.gateway.emitRunLog({
        category: 'context',
        level: 'success',
        message: `Code context ready — ${embedResult.files_indexed} files, ${embedResult.chunks_indexed} chunks (${embedResult.model}).`,
        meta: {
          filesIndexed: embedResult.files_indexed,
          chunksIndexed: embedResult.chunks_indexed,
          filesAdded: embedResult.files_added,
          filesUpdated: embedResult.files_updated,
          filesRemoved: embedResult.files_removed,
          filesUnchanged: embedResult.files_unchanged,
          incremental: embedResult.incremental,
          model: embedResult.model,
        },
      });

      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: `Context build took ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
        durationMs: Date.now() - startedAt,
      });
      this.gateway.emitContextReady();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Context pipeline failed: ${message}`);
      onError('embed_failed', message);
      return false;
    } finally {
      this.building = false;
      this.contextService.setBuilding(false);
      this.gateway.emitRunLog({
        category: 'context',
        level: 'debug',
        message: 'Context pipeline finished (building flag cleared).',
      });
      if (this.embedAgainAfterBuild) {
        this.embedAgainAfterBuild = false;
        this.scheduleIncrementalEmbed();
      }
    }
  }

  /** Checks shared by every run; emits the context error itself when one fails. */
  private preflight(): Preflight | null {
    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      this.gateway.emitContextError(
        'no_workspace',
        'Workspace path is not set.',
      );
      return null;
    }

    if (!this.contextService.isContextReady()) {
      this.gateway.emitContextError(
        'context_not_ready',
        'Code context is still being created. Wait for embeddings to finish.',
      );
      return null;
    }

    const frontendPort = this.contextService.getFrontendPort();
    if (!frontendPort) {
      this.gateway.emitContextError(
        'no_frontend_port',
        'Test frontend port is not set. Enter it on the connection screen.',
      );
      return null;
    }

    const validated = this.validateWorkspaceOrEmitError(workspacePath);
    if (!validated.ok) {
      return null;
    }
    return { workspacePath, frontendPort, bucket: validated.supabase.bucket };
  }

  /** Run the demo plan (no saved steps) from the Run screen. */
  async startCdpRun(
    steps?: CdpStepDefinition[],
    conversationId?: string | null,
    cdpStepId?: string | null,
  ): Promise<void> {
    await withTrace('run', steps ? 'Run · saved plan' : 'Run · demo flow', () =>
      this.runCasesInTrace(steps, conversationId, cdpStepId),
    );
  }

  private async runCasesInTrace(
    steps?: CdpStepDefinition[],
    conversationId?: string | null,
    cdpStepId?: string | null,
  ): Promise<void> {
    await this.runCases({
      conversationId: conversationId ?? null,
      suiteId: null,
      items: [
        {
          caseId: cdpStepId ?? 'demo',
          suiteId: null,
          steps: steps ?? demoCdpSteps(),
          runFolder: `${runStamp()}_${steps ? 'plan' : 'demo'}`,
        },
      ],
    });
  }

  /**
   * Run test cases one after another, each in a fresh browser.
   * More than one case makes a group run with its own batch id.
   */
  async runCases(input: {
    conversationId: string | null;
    suiteId: string | null;
    items: CaseRunItem[];
  }): Promise<void> {
    if (this.cdpRunning) {
      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'warn',
        message:
          'A test run is already in progress — wait for it to finish or click Refresh.',
      });
      return;
    }
    if (input.items.length === 0) {
      return;
    }

    this.cdpRunning = true;
    const batchId = input.items.length > 1 ? randomUUID() : null;
    let passed = 0;
    let failed = 0;
    try {
      const pre = this.preflight();
      if (!pre) {
        return;
      }
      if (batchId && input.conversationId) {
        this.gateway.sendBatchStarted(
          batchId,
          input.conversationId,
          input.suiteId,
          input.items.map((item) => item.caseId),
        );
      }
      for (const [index, item] of input.items.entries()) {
        if (input.items.length > 1) {
          this.gateway.emitRunLog({
            category: 'cdp',
            level: 'info',
            message: `Case ${index + 1} of ${input.items.length} — ${item.runFolder}`,
            meta: { caseId: item.caseId, runFolder: item.runFolder },
          });
        }
        const status = await this.executeRun(pre, item, {
          conversationId: input.conversationId,
          caseId: item.caseId,
          suiteId: item.suiteId,
          batchId,
        });
        if (status === 'success') {
          passed += 1;
        } else {
          failed += 1;
        }
      }
    } finally {
      this.cdpRunning = false;
      if (batchId) {
        this.gateway.sendBatchComplete(
          batchId,
          input.items.length,
          passed,
          failed,
        );
      }
      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'debug',
        message: 'CDP run finished (cdpRunning flag cleared).',
      });
    }
  }

  private async executeRun(
    pre: Preflight,
    item: CaseRunItem,
    context: RunContext,
  ): Promise<'success' | 'fail'> {
    const baseUrl = `http://127.0.0.1:${pre.frontendPort}`;
    this.gateway.emitRunLog({
      category: 'cdp',
      level: 'info',
      message: `Launching browser for ${item.steps.length} step(s) on ${baseUrl}…`,
      meta: { baseUrl, caseId: context.caseId, batchId: context.batchId },
    });

    const runStartedAt = Date.now();
    const screenshots: string[] = [];
    const recording: { started: Promise<string | null> } = {
      started: Promise.resolve(null),
    };
    let outcome: {
      status: 'success' | 'fail';
      message: string;
      failedStep: string;
    } = { status: 'fail', message: 'The run did not finish.', failedStep: '' };

    try {
      await this.cdpRunner.runDemoFlow(
        pre.frontendPort,
        pre.workspacePath,
        pre.bucket,
        {
          onRunStart: (runId) => {
            this.gateway.sendCdpStarted(
              runId,
              context.conversationId,
              context.caseId,
              context.batchId,
            );
            if (this.recorder) {
              recording.started = this.recorder
                .start({ ...context, runFolder: runId })
                .catch((err: unknown) => {
                  const detail =
                    err instanceof Error ? err.message : String(err);
                  this.logger.error(`Could not record run start: ${detail}`);
                  return null;
                });
            }
          },
          onStep: (stepId, label) => this.gateway.sendStepUpdate(stepId, label),
          onLog: (stepId, message) =>
            this.gateway.sendLog(stepId, message, 'cdp'),
          onScreenshot: (stepId, url) => {
            if (url) {
              screenshots.push(url);
            }
            this.gateway.sendScreenshot(stepId, url);
          },
          onComplete: (status, message, failedStep) => {
            outcome = { status, message, failedStep };
          },
        },
        item.steps,
        item.runFolder,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDP run failed: ${message}`);
      this.gateway.emitContextError('cdp_failed', message);
      outcome = { status: 'fail', message, failedStep: '' };
    }

    if (this.recorder) {
      try {
        await this.recorder.finish(context, {
          testRunId: await recording.started,
          status: outcome.status === 'success' ? 'passed' : 'failure',
          statusMessage: compactStatusMessage(outcome.message),
          failedStep: outcome.failedStep,
          screenshots: [...screenshots],
        });
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(`Could not record CDP run: ${detail}`);
      }
    }
    this.gateway.emitRunLog({
      category: 'cdp',
      level: outcome.status === 'success' ? 'success' : 'error',
      message:
        outcome.status === 'success'
          ? `Case passed in ${((Date.now() - runStartedAt) / 1000).toFixed(1)}s (${screenshots.length} screenshots).`
          : `Case failed${outcome.failedStep ? ` at “${outcome.failedStep}”` : ''}: ${compactStatusMessage(outcome.message).slice(0, 300)}`,
      durationMs: Date.now() - runStartedAt,
      meta: {
        caseId: context.caseId,
        runFolder: item.runFolder,
        failedStep: outcome.failedStep || undefined,
      },
    });
    this.gateway.sendComplete(outcome.status, context.caseId, context.batchId);
    return outcome.status;
  }

  async startContextPipeline(): Promise<void> {
    await withTrace('context', 'Build code context', () =>
      this.runEmbedPipeline({ trigger: 'initial' }),
    );
  }

  /** REST bootstrap for standalone clients (e.g. Tursor-Chat-Sample). */
  async bootstrapWorkspace(workspacePath: string): Promise<
    | {
        ok: true;
        workspacePath: string;
        contextReady: true;
        filesIndexed: number;
        chunksIndexed: number;
        model: string;
      }
    | { ok: false; error: string }
  > {
    const path = workspacePath.trim();
    if (!path) {
      return { ok: false, error: 'workspacePath is required' };
    }

    const validated = this.validator.validate(path);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }

    this.contextService.setWorkspaceContext(path);

    if (!(await this.ensureTursorAiReady())) {
      return {
        ok: false,
        error:
          'Tursor-AI is not reachable. Run `tursorAI start` or re-run install.',
      };
    }

    try {
      await this.tursorAi.ensureReady();
      const aiValidate = await this.tursorAi.validate(path);
      if (!aiValidate.ok) {
        return {
          ok: false,
          error: aiValidate.error ?? 'Tursor-AI validation failed.',
        };
      }

      const embedResult = await this.tursorAi.embed(path);
      await this.buildFlowMap(
        path,
        embedResult.flow_map_needed === true,
        false,
      );
      this.contextService.markContextReady({
        embeddingsDir: embedResult.embeddings_dir,
        filesIndexed: embedResult.files_indexed,
        chunksIndexed: embedResult.chunks_indexed,
        model: embedResult.model,
      });

      return {
        ok: true,
        workspacePath: path,
        contextReady: true,
        filesIndexed: embedResult.files_indexed,
        chunksIndexed: embedResult.chunks_indexed,
        model: embedResult.model,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`REST bootstrap failed: ${message}`);
      return { ok: false, error: message };
    }
  }
}
