import { Module } from '@nestjs/common';
import { TursorAiModule } from '../tursor-ai/tursor-ai.module';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { WorkspaceConfigValidator } from './workspace-config.validator';

@Module({
  imports: [TursorAiModule],
  controllers: [ContextController],
  providers: [ContextService, WorkspaceConfigValidator],
  exports: [ContextService, WorkspaceConfigValidator, TursorAiModule],
})
export class ContextModule {}
