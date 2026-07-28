import { Module } from '@nestjs/common';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { WorkspaceConfigValidator } from './workspace-config.validator';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';

@Module({
  controllers: [ContextController],
  providers: [ContextService, WorkspaceConfigValidator, TursorAiClient],
  exports: [ContextService, WorkspaceConfigValidator, TursorAiClient],
})
export class ContextModule {}
