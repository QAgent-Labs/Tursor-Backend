import { Module } from '@nestjs/common';
import { TursorAiClient } from './tursor-ai.client';
import { TursorAiRuntimeService } from './tursor-ai-runtime.service';

@Module({
  providers: [TursorAiRuntimeService, TursorAiClient],
  exports: [TursorAiRuntimeService, TursorAiClient],
})
export class TursorAiModule {}
