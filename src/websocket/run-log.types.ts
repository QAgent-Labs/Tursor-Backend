export type RunLogCategory =
  | 'connection'
  | 'context'
  | 'flowmap'
  | 'intent'
  | 'retrieval'
  | 'llm'
  | 'suite'
  | 'prd'
  | 'report'
  | 'cdp'
  | 'step'
  | 'screenshot'
  | 'chat'
  | 'system'
  | 'error';

export const RUN_LOG_CATEGORIES: ReadonlySet<string> = new Set<RunLogCategory>([
  'connection',
  'context',
  'flowmap',
  'intent',
  'retrieval',
  'llm',
  'suite',
  'prd',
  'report',
  'cdp',
  'step',
  'screenshot',
  'chat',
  'system',
  'error',
]);

export type RunLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export const RUN_LOG_LEVELS: ReadonlySet<string> = new Set<RunLogLevel>([
  'debug',
  'info',
  'warn',
  'error',
  'success',
]);

/** Which process wrote the line. */
export type RunLogSource = 'backend' | 'ai';

export type RunLogPayload = {
  category: RunLogCategory;
  level?: RunLogLevel;
  message: string;
  stepId?: string;
  meta?: Record<string, unknown>;
  durationMs?: number;
};

export type RunLogSocketEvent = {
  type: 'log';
  source: RunLogSource;
  category: RunLogCategory;
  level: RunLogLevel;
  message: string;
  timestamp: string;
  stepId?: string;
  meta?: Record<string, unknown>;
  durationMs?: number;
  /** Groups lines of one chat turn, context build, run, or report. */
  traceId?: string;
  traceKind?: string;
  traceLabel?: string;
};
