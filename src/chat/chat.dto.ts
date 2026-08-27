import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatIntroRequestDto {
  @ApiPropertyOptional({
    description:
      'Absolute workspace path. Required when no active WebSocket session.',
    example: '/Users/dev/my-app',
  })
  workspacePath?: string;
}

export class ChatMessageRequestDto {
  @ApiProperty({ description: 'Conversation UUID from POST /chat/intro' })
  conversationId!: string;

  @ApiProperty({ description: 'User message text' })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Workspace path for curl-only testing without an active WS session.',
  })
  workspacePath?: string;
}

export class ChatConversationIdRequestDto {
  @ApiProperty({ description: 'Conversation UUID' })
  conversationId!: string;
}

export class TestFlowStepDto {
  @ApiProperty()
  step!: number;

  @ApiProperty()
  action!: string;
}

export class AiStructuredResponseDto {
  @ApiProperty({
    enum: ['conversation', 'test_proposal', 'test_generation', 'error'],
  })
  type!: string;

  @ApiPropertyOptional()
  content?: string;

  @ApiPropertyOptional()
  status?: string;

  @ApiPropertyOptional({ type: [TestFlowStepDto] })
  testFlow?: TestFlowStepDto[];

  @ApiPropertyOptional()
  code?: string;
}

export class ConversationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  workspacePath!: string;

  @ApiProperty()
  status!: string;

  @ApiPropertyOptional()
  title?: string | null;

  @ApiProperty()
  summary!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class ChatMessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['user', 'assistant', 'system'] })
  role!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty()
  messageType!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  metadata?: Record<string, unknown>;

  @ApiProperty()
  createdAt!: string;
}

export class GeneratedTestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  conversationId!: string;

  @ApiProperty()
  workspacePath!: string;

  @ApiPropertyOptional()
  testName?: string | null;

  @ApiProperty()
  language!: string;

  @ApiProperty()
  framework!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  createdAt!: string;
}

export class ChatIntroResponseDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: ChatMessageDto })
  message!: ChatMessageDto;

  @ApiProperty({ type: AiStructuredResponseDto })
  ai!: AiStructuredResponseDto;
}

export class ChatMessageResponseDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: ChatMessageDto })
  message!: ChatMessageDto;

  @ApiProperty({ type: AiStructuredResponseDto })
  ai!: AiStructuredResponseDto;
}

export class ChatApproveTestFlowResponseDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: ChatMessageDto })
  message!: ChatMessageDto;

  @ApiProperty({ type: AiStructuredResponseDto })
  ai!: AiStructuredResponseDto;

  @ApiProperty({ type: GeneratedTestDto })
  generatedTest!: GeneratedTestDto;
}

export class ChatApproveExecutionResponseDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: GeneratedTestDto })
  generatedTest!: GeneratedTestDto;

  @ApiProperty()
  executionStarted!: boolean;
}

export class ChatGetConversationResponseDto {
  @ApiProperty({ type: ConversationDto })
  conversation!: ConversationDto;

  @ApiProperty({ type: [ChatMessageDto] })
  messages!: ChatMessageDto[];

  @ApiPropertyOptional({ type: GeneratedTestDto, nullable: true })
  generatedTest!: GeneratedTestDto | null;
}
