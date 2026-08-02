import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
// import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { ContextService } from '../context/context.service';
import { CdpRunnerService } from '../cdp/cdp-runner.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import { WebsocketGateway } from './websocket.gateway';

@Injectable()
export class RunOrchestratorService {
  private readonly logger = new Logger(RunOrchestratorService.name);
  private building = false;

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

  async startContextPipeline(): Promise<void> {
    if (this.building) {
      this.logger.log('Context build already in progress');
      this.gateway.emitRunLog({
        category: 'context',
        level: 'warn',
        message: 'Context pipeline already in progress — skipping duplicate start.',
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
      this.gateway.emitRunLog({
        category: 'context',
        level: 'info',
        message: 'Validating local .tursor/config.json…',
        meta: { workspacePath },
      });

      const local = this.validator.validate(workspacePath);
      if (!local.ok) {
        this.gateway.emitContextError(
          'missing_tursor_config',
          local.error,
        );
        return;
      }

      this.gateway.emitRunLog({
        category: 'context',
        level: 'success',
        message: 'Local workspace config validation passed.',
      });

      /* Tursor-AI embed disabled for now — skip remote validate/embed and go straight to CDP. */
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
        this.gateway.emitRunLog({
          category: 'cdp',
          level: 'info',
          message: `Starting CDP demo flow against frontend port ${frontendPort}.`,
          meta: { frontendPort, baseUrl: `http://127.0.0.1:${frontendPort}` },
        });

        await this.cdpRunner.runDemoFlow(frontendPort, workspacePath, {
          onStep: (stepId, label) => this.gateway.sendStepUpdate(stepId, label),
          onLog: (stepId, message) => this.gateway.sendLog(stepId, message, 'cdp'),
          onScreenshot: (stepId, url) =>
            this.gateway.sendScreenshot(stepId, url),
          onComplete: (status) => this.gateway.sendComplete(status),
        });
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
