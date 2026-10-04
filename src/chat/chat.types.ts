export type ConversationStatus =
  | 'NORMAL'
  | 'TEST_DISCUSSION'
  | 'AWAITING_TEST_APPROVAL'
  | 'GENERATING_TEST'
  | 'TEST_GENERATED'
  | 'EXECUTING'
  | 'COMPLETED';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType = 'chat';

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

export type SummaryPlan = {
  id: string;
  title: string;
};

export type ConversationSummary = {
  case: string;
  plans: SummaryPlan[];
};

export type ChatTurnResponse = {
  conversationId: string;
  reply: string;
  cdpStepsId: string | null;
  summary: ConversationSummary;
};

export type ConversationListItem = {
  id: string;
  summary: ConversationSummary;
  createdAt: string;
  updatedAt: string;
};
