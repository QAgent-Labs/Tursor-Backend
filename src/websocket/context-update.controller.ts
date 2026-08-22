import { Body, Controller, Post } from '@nestjs/common';
import { RunOrchestratorService } from './run-orchestrator.service';

type ContextUpdateBody = {
  path?: string;
};

@Controller('context')
export class ContextUpdateController {
  constructor(private readonly runOrchestrator: RunOrchestratorService) {}

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
