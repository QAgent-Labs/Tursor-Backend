import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** What one group of log lines belongs to; the log panel groups by traceId. */
export type TraceKind = 'chat' | 'context' | 'run' | 'report' | 'system';

export type Trace = {
  traceId: string;
  kind: TraceKind;
  label: string;
  startedAt: number;
};

const storage = new AsyncLocalStorage<Trace>();

/** Recent traces, so logs Tursor-AI sends back by id get the same kind and label. */
const recent = new Map<string, Trace>();
const MAX_RECENT = 200;

function remember(trace: Trace): void {
  recent.set(trace.traceId, trace);
  // Maps keep insertion order, so the first key is the oldest trace.
  for (const oldest of recent.keys()) {
    if (recent.size <= MAX_RECENT) break;
    recent.delete(oldest);
  }
}

/** Run fn with a new trace; every log emitted inside (sync or async) carries it. */
export function withTrace<T>(
  kind: TraceKind,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const trace: Trace = {
    traceId: randomUUID(),
    kind,
    label: label.length > 80 ? `${label.slice(0, 79)}…` : label,
    startedAt: Date.now(),
  };
  remember(trace);
  return storage.run(trace, fn);
}

export function currentTrace(): Trace | null {
  return storage.getStore() ?? null;
}

export function findTrace(traceId: string): Trace | null {
  return recent.get(traceId) ?? null;
}
