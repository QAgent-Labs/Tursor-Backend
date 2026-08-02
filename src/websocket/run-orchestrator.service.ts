import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
// import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { ContextService } from '../context/context.service';
import { CdpRunnerService } from '../cdp/cdp-runner.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import { WebsocketGateway } from './websocket.gateway';
import type { CdpRunCallbacks } from '../cdp/cdp-step.types';

@Injectable()
export class RunOrchestratorService {
  private readonly logger = new Logger(RunOrchestratorService.name);
  private building = false;
  private cdpRunning = false;

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    // private readonly tursorAi: TursorAiClient,
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

  private cdpCallbacks(): CdpRunCallbacks {
    return {
      onStep: (stepId, label) => this.gateway.sendStepUpdate(stepId, label),
      onLog: (stepId, message) =>
        this.gateway.sendLog(stepId, message, 'cdp'),
      onScreenshot: (stepId, url) => this.gateway.sendScreenshot(stepId, url),
      onComplete: (status) => this.gateway.sendComplete(status),
    };
  }

  private validateWorkspaceOrEmitError(
    workspacePath: string,
  ): { ok: true } | { ok: false } {
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
      message: 'Local workspace config validation passed.',
    });
    return { ok: true };
  }

  /** Run Playwright demo steps against the session frontend port (Run screen entry). */
  async startCdpRun(): Promise<void> {
    if (this.cdpRunning) {
      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'warn',
        message: 'CDP demo already running — wait for it to finish or click Refresh.',
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

      this.contextService.markContextReady({
        embeddingsDir: '',
        filesIndexed: 0,
        chunksIndexed: 0,
        model: 'disabled',
      });
      this.gateway.emitContextReady();

      this.gateway.emitRunLog({
        category: 'cdp',
        level: 'info',
        message: `Launching browser and running demo steps on ${baseUrl}…`,
        meta: { frontendPort, baseUrl },
      });

      await this.cdpRunner.runDemoFlow(
        frontendPort,
        workspacePath,
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
    if (this.building) {
      this.logger.log('Context build already in progress');
      this.gateway.emitRunLog({
        category: 'context',
        level: 'warn',
        message:
          'Context pipeline already in progress — skipping duplicate start.',
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

    this.building = true;
    this.gateway.emitRunLog({
      category: 'context',
      level: 'info',
      message: `Starting context pipeline for workspace: ${workspacePath}`,
      meta: { workspacePath },
    });

    try {
      const validated = this.validateWorkspaceOrEmitError(workspacePath);
      if (!validated.ok) {
        return;
      }

      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: 'Tursor-AI embed disabled — skipping remote validate/embed.',
      });

      this.contextService.markContextReady({
        embeddingsDir: '',
        filesIndexed: 0,
        chunksIndexed: 0,
        model: 'disabled',
      });

      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: 'Context marked ready (embeddings disabled).',
        meta: { model: 'disabled', filesIndexed: 0, chunksIndexed: 0 },
      });

      this.gateway.emitContextReady();

      const frontendPort = this.contextService.getFrontendPort();
      if (frontendPort) {
        await this.startCdpRun();
      } else {
        this.gateway.emitRunLog({
          category: 'cdp',
          level: 'warn',
          message:
            'No frontend port configured — CDP demo flow skipped. Set frontend port on the connection screen.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Context pipeline failed: ${message}`);
      this.gateway.emitContextError('embed_failed', message);
    } finally {
      this.building = false;
      this.gateway.emitRunLog({
        category: 'context',
        level: 'debug',
        message: 'Context pipeline finished (building flag cleared).',
      });
    }
  }
}
