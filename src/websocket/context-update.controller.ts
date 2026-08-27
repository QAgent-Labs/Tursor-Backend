import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RunOrchestratorService } from './run-orchestrator.service';

type ContextUpdateBody = {
  path?: string;
};

type BootstrapBody = {
  workspacePath?: string;
};

@ApiTags('context')
@Controller('context')
export class ContextUpdateController {
  constructor(private readonly runOrchestrator: RunOrchestratorService) {}

  @Post('bootstrap')
  @ApiOperation({
    summary: 'Set workspace and build embeddings (for sample chat UI)',
    description:
      'Validates config, embeds workspace via Tursor-AI, marks context_ready. ' +
      'Required before POST /chat/message when not using the Extension WebSocket session.',
  })
  bootstrap(@Body() body: BootstrapBody) {
    const workspacePath = body.workspacePath?.trim() ?? '';
    return this.runOrchestrator.bootstrapWorkspace(workspacePath);
  }

  @Post('update')
  queueIncrementalUpdate(@Body() body: ContextUpdateBody) {
    const changedPath =
      typeof body.path === 'string' && body.path.trim()
        ? body.path.trim()
        : undefined;
    this.runOrchestrator.scheduleIncrementalEmbed(changedPath);
    return { ok: true, queued: true };
  }
}
