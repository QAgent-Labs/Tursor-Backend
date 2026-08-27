import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from '../tursor-ai/tursor-ai-runtime.service';
import { ContextService } from '../context/context.service';
import { CdpRunnerService } from '../cdp/cdp-runner.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import type { WorkspaceSupabaseConfig } from '../context/workspace-config.types';
import { WebsocketGateway } from './websocket.gateway';
import type { CdpRunCallbacks } from '../cdp/cdp-step.types';

@Injectable()
export class RunOrchestratorService {
  private readonly logger = new Logger(RunOrchestratorService.name);
  private building = false;
  private cdpRunning = false;
  private embedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEmbedPath: string | null = null;

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    private readonly tursorAiRuntime: TursorAiRuntimeService,
    private readonly tursorAi: TursorAiClient,
    private readonly cdpRunner: CdpRunnerService,
    @Inject(forwardRef(() => WebsocketGateway))
    private readonly gateway: WebsocketGateway,
  ) {}

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
      if (
        normalized.includes('/.tursor/embeddings/') ||
        normalized.includes('/.tursor/run-screenshots/')
      ) {
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
      void this.runEmbedPipeline({
        trigger: 'file_change',
        changedPath: pathHint ?? undefined,
      });
    }, 1500);
  }

  private cdpCallbacks(): CdpRunCallbacks {
    return {
      onStep: (stepId, label) => this.gateway.sendStepUpdate(stepId, label),
      onLog: (stepId, message) => this.gateway.sendLog(stepId, message, 'cdp'),
      onScreenshot: (stepId, url) => this.gateway.sendScreenshot(stepId, url),
      onComplete: (status) => this.gateway.sendComplete(status),
    };
  }

  private validateWorkspaceOrEmitError(
    workspacePath: string,
  ): { ok: true; supabase: WorkspaceSupabaseConfig } | { ok: false } {
    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message: 'Validating local .tursor/config.json…',
      meta: { workspacePath },
    });

    const local = this.validator.validate(workspacePath);
    if (!local.ok) {
      this.gateway.emitContextError('missing_tursor_config', local.error);
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

  private async ensureTursorAiReady(): Promise<boolean> {
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

    this.gateway.emitContextError(
      'tursor_ai_unreachable',
      'Tursor-AI is not reachable. Run `tursorAI start` or re-run Tursor install (Python 3.10+ required).',
    );
    return false;
  }

  private async runEmbedPipeline(options?: {
    trigger?: 'initial' | 'file_change' | 'manual';
    changedPath?: string;
  }): Promise<boolean> {
    if (this.building) {
      this.gateway.emitRunLog({
        category: 'context',
        level: 'warn',
        message: 'Context pipeline already in progress — skipping duplicate run.',
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
    this.contextService.resetContextReady();
    this.gateway.emitContextBuilding();

    const trigger = options?.trigger ?? 'manual';
    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message:
        trigger === 'file_change'
          ? `Updating code context after file change${options?.changedPath ? `: ${options.changedPath}` : ''}.`
          : `Building code context for workspace: ${workspacePath}`,
      meta: { workspacePath, trigger, changedPath: options?.changedPath ?? null },
    });

    try {
      const validated = this.validateWorkspaceOrEmitError(workspacePath);
      if (!validated.ok) {
        return false;
      }

      if (!(await this.ensureTursorAiReady())) {
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
        this.gateway.emitContextError(
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

      this.gateway.emitContextReady();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Context pipeline failed: ${message}`);
      this.gateway.emitContextError('embed_failed', message);
      return false;
    } finally {
      this.building = false;
      this.gateway.emitRunLog({
        category: 'context',
        level: 'debug',
        message: 'Context pipeline finished (building flag cleared).',
      });
    }
  }

  /** Run Playwright demo steps against the session frontend port. */
  async startCdpRun(): Promise<void> {
    if (this.cdpRunning) {
      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'warn',
        message:
          'CDP demo already running — wait for it to finish or click Refresh.',
      });
      return;
    }

    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      this.gateway.emitContextError(
        'no_workspace',
        'Workspace path is not set.',
      );
      return;
    }

    if (!this.contextService.isContextReady()) {
      this.gateway.emitContextError(
        'context_not_ready',
        'Code context is still being created. Wait for embeddings to finish.',
      );
      return;
    }

    const frontendPort = this.contextService.getFrontendPort();
    if (!frontendPort) {
      this.gateway.emitContextError(
        'no_frontend_port',
        'Test frontend port is not set. Enter it on the connection screen.',
      );
      return;
    }

    this.cdpRunning = true;
    const baseUrl = `http://127.0.0.1:${frontendPort}`;

    this.gateway.emitRunLog({
      category: 'cdp',
      level: 'info',
      message: `CDP run requested — targeting ${baseUrl}`,
      meta: { frontendPort, baseUrl, workspacePath },
    });

    try {
      const validated = this.validateWorkspaceOrEmitError(workspacePath);
      if (!validated.ok) {
        return;
      }

      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'info',
        message: `Launching browser and running demo steps on ${baseUrl}…`,
        meta: { frontendPort, baseUrl },
      });

      await this.cdpRunner.runDemoFlow(
        frontendPort,
        workspacePath,
        validated.supabase.bucket,
        this.cdpCallbacks(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDP run failed: ${message}`);
      this.gateway.emitContextError('cdp_failed', message);
    } finally {
      this.cdpRunning = false;
      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'debug',
        message: 'CDP run finished (cdpRunning flag cleared).',
      });
    }
  }

  async startContextPipeline(): Promise<void> {
    await this.runEmbedPipeline({ trigger: 'initial' });
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
