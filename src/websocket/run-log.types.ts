export type RunLogCategory =
  | 'connection'
  | 'context'
  | 'cdp'
  | 'step'
  | 'screenshot'
  | 'chat'
  | 'system'
  | 'error';

export type RunLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export type RunLogPayload = {
  category: RunLogCategory;
  level?: RunLogLevel;
  message: string;
  stepId?: string;
  meta?: Record<string, unknown>;
};

export type RunLogSocketEvent = {
  type: 'log';
  category: RunLogCategory;
  level: RunLogLevel;
  message: string;
  timestamp: string;
  stepId?: string;
  meta?: Record<string, unknown>;
};
