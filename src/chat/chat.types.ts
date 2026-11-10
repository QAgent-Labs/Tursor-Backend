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

export type SuiteCaseKind = 'success' | 'failure' | 'edge';

/** One test case shown in this conversation (id is a test_cases row, or a legacy cdp_plans row). */
export type SummaryPlan = {
  id: string;
  title: string;
  response_id: string;
  feature: string;
  kind: SuiteCaseKind | '';
  suite_id: string;
  version: number;
};

export type CdpRunStatus = 'passed' | 'failure';

export type CdpRunRecord = {
  cdp_step_id: string;
  case_id: string;
  status: CdpRunStatus;
  status_message: string;
  screenshots: string[];
  response_id: string;
  feature: string;
  title: string;
  kind: SuiteCaseKind | '';
  suite_id: string;
};

export type ConversationSummary = {
  case: string;
  brief_summary: string;
  plans: SummaryPlan[];
  cdp_runs: CdpRunRecord[];
  intent: string;
  focus_paths: string[];
  /** Suite version this conversation is working on (created or reused here). */
  active_suite_id: string;
  /** What Tursor asked at the end of its last reply; the next "yes" acts on it. */
  pending_action:
    | ''
    | 'generate'
    | 'reuse'
    | 'new_version'
    | 'collect_generate'
    | 'collect_new_version';
  /** The saved suite that question is about (reuse or new_version). */
  pending_suite_id: string;
  /** PRD shared in this conversation; generated cases link to its requirements. */
  prd_id: string;
};

export type ChatSuiteCase = {
  id: string;
  kind: SuiteCaseKind;
  title: string;
  explanation: string;
  requirementIds: string[];
};

export type ChatSuite = {
  feature: string;
  suiteId: string;
  version: number;
  moduleKey: string;
  moduleName: string;
  reused: boolean;
  cases: ChatSuiteCase[];
};

export type ChatPrdResult = {
  id: string;
  title: string;
  verdict: 'aligned' | 'gaps';
  requirements: Array<{
    id: string;
    text: string;
    status: 'implemented' | 'partial' | 'missing';
    gap: string;
  }>;
};

export type ChatTurnResponse = {
  conversationId: string;
  responseId: string;
  reply: string;
  suite: ChatSuite | null;
  summary: ConversationSummary;
  prd?: ChatPrdResult | null;
};

export type ConversationListItem = {
  id: string;
  summary: ConversationSummary;
  createdAt: string;
  updatedAt: string;
};
