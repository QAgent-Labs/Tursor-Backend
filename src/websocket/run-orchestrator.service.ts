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
      return;
    }

    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      this.gateway.emit({
        type: 'context_error',
        code: 'no_workspace',
        message: 'Workspace path is not set.',
      });
      return;
    }

    this.building = true;

    try {
      const local = this.validator.validate(workspacePath);
      if (!local.ok) {
        this.gateway.emit({
          type: 'context_error',
          code: 'missing_tursor_config',
          message: local.error,
        });
        return;
      }

      /* Tursor-AI embed disabled for now — skip remote validate/embed and go straight to CDP. */
      // this.gateway.emit({ type: 'context_building' });
      // await this.tursorAi.ensureReady();
      // const remote = await this.tursorAi.validate(workspacePath);
      // if (!remote.ok) { ... }
      // const embed = await this.tursorAi.embed(workspacePath);
      // this.contextService.markContextReady({ ... });

      this.contextService.markContextReady({
        embeddingsDir: '',
        filesIndexed: 0,
        chunksIndexed: 0,
        model: 'disabled',
      });
      this.gateway.emit({ type: 'context_ready' });

      const frontendPort = this.contextService.getFrontendPort();
      if (frontendPort) {
        await this.cdpRunner.runDemoFlow(frontendPort, workspacePath, {
          onStep: (stepId, label) => this.gateway.sendStepUpdate(stepId, label),
          onLog: (stepId, message) => this.gateway.sendLog(stepId, message),
          onScreenshot: (stepId, url) =>
            this.gateway.sendScreenshot(stepId, url),
          onComplete: (status) => this.gateway.sendComplete(status),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Context pipeline failed: ${message}`);
      this.gateway.emit({
        type: 'context_error',
        code: 'embed_failed',
        message,
      });
    } finally {
      this.building = false;
    }
  }
}
