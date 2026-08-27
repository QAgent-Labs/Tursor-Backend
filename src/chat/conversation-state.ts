import type { AiResponseType, ConversationStatus } from './chat.types';

export function nextStatusAfterAiResponse(
  current: ConversationStatus,
  aiType: AiResponseType,
): ConversationStatus {
  if (aiType === 'test_proposal') {
    return 'AWAITING_TEST_APPROVAL';
  }
  if (aiType === 'test_generation') {
    return 'TEST_GENERATED';
  }
  if (aiType === 'error') {
    return current;
  }
  if (current === 'NORMAL' && aiType === 'conversation') {
    return 'NORMAL';
  }
  if (
    current === 'AWAITING_TEST_APPROVAL' &&
    aiType === 'conversation'
  ) {
    return 'TEST_DISCUSSION';
  }
  return current;
}

export function canApproveTestFlow(status: ConversationStatus): boolean {
  return status === 'AWAITING_TEST_APPROVAL';
}

export function canGenerateTest(status: ConversationStatus): boolean {
  return (
    status === 'AWAITING_TEST_APPROVAL' || status === 'TEST_DISCUSSION'
  );
}

export function canExecuteTest(status: ConversationStatus): boolean {
  return status === 'TEST_GENERATED';
}
