import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import {
  ChatConversationIdRequestDto,
  ChatIntroRequestDto,
  ChatMessageRequestDto,
} from './chat.dto';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatOrchestratorService) {}

  @Post('intro')
  @ApiOperation({
    summary: 'Start a new chat conversation',
    description:
      'Creates a Supabase conversation row and returns an LLM intro message. ' +
      'Requires `ai` block in `.tursor/config.json`.',
  })
  intro(@Body() body: ChatIntroRequestDto) {
    return this.chat.intro(body.workspacePath);
  }

  @Post('message')
  @ApiOperation({
    summary: 'Send a user message',
    description:
      'Persists the message, runs RAG + LLM via Tursor-AI, updates conversation state. ' +
      'Requires workspace embeddings (`context_ready`).',
  })
  message(@Body() body: ChatMessageRequestDto) {
    return this.chat.postMessage(
      body.conversationId,
      body.message,
      body.workspacePath,
    );
  }

  @Post('approve-test-flow')
  @ApiOperation({
    summary: 'Approve proposed test flow and generate Playwright code',
    description:
      'Conversation must be in AWAITING_TEST_APPROVAL. Calls Tursor-AI in generate_test mode.',
  })
  approveTestFlow(@Body() body: ChatConversationIdRequestDto) {
    return this.chat.approveTestFlow(body.conversationId);
  }

  @Post('approve-execution')
  @ApiOperation({
    summary: 'Approve and start test execution',
    description:
      'Starts the Backend CDP demo run (phase 1). Generated test code is persisted for phase 2.',
  })
  approveExecution(@Body() body: ChatConversationIdRequestDto) {
    return this.chat.approveExecution(body.conversationId);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation with messages and latest generated test' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  getConversation(@Param('id') id: string) {
    return this.chat.getConversation(id);
  }
}
