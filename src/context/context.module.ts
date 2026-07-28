import { Module } from '@nestjs/common';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { WorkspaceConfigValidator } from './workspace-config.validator';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from '../tursor-ai/tursor-ai-runtime.service';

@Module({
  controllers: [ContextController],
  providers: [
    ContextService,
    WorkspaceConfigValidator,
    TursorAiRuntimeService,
    TursorAiClient,
  ],
  exports: [
    ContextService,
    WorkspaceConfigValidator,
    TursorAiRuntimeService,
    TursorAiClient,
  ],
})
export class ContextModule {}
