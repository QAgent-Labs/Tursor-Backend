export type ConversationStatus =
  | 'NORMAL'
  | 'TEST_DISCUSSION'
  | 'AWAITING_TEST_APPROVAL'
  | 'GENERATING_TEST'
  | 'TEST_GENERATED'
  | 'EXECUTING'
  | 'COMPLETED';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType =
  | 'chat'
  | 'test_proposal'
  | 'test_generation'
  | 'test_approval'
  | 'execution_result';

export type AiResponseType =
  | 'conversation'
  | 'test_proposal'
  | 'test_generation'
  | 'error';

export type TestFlowStep = {
  step: number;
  action: string;
};

export type ChatMessageDto = {
  id: string;
  role: MessageRole;
  content: string;
  messageType: MessageType;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ConversationDto = {
  id: string;
  workspacePath: string;
  status: ConversationStatus;
  title: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedTestDto = {
  id: string;
  conversationId: string;
  workspacePath: string;
  testName: string | null;
  language: string;
  framework: string;
  code: string;
  version: number;
  status: string;
  createdAt: string;
};

export type AiStructuredResponse = {
  type: AiResponseType;
  content?: string;
  status?: string;
  testFlow?: TestFlowStep[];
  language?: string;
  framework?: string;
  testName?: string;
  code?: string;
  retrievedChunkCount?: number;
};
