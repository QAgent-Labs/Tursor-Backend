import { Module, forwardRef } from '@nestjs/common';
import { ContextModule } from '../context/context.module';
import { TursorAiModule } from '../tursor-ai/tursor-ai.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { ChatController } from './chat.controller';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import { SupabaseChatService } from './supabase-chat.service';

@Module({
  imports: [
    ContextModule,
    TursorAiModule,
    forwardRef(() => WebsocketModule),
  ],
  controllers: [ChatController],
  providers: [SupabaseChatService, ChatOrchestratorService],
  exports: [ChatOrchestratorService],
})
export class ChatModule {}
