import { ContextService } from '../context/context.service';
import { withTrace } from '../lib/trace';
import {
  WebsocketGateway,
  type OutboundSocketEvent,
} from './websocket.gateway';

function gatewayWithSpy(): {
  gateway: WebsocketGateway;
  events: OutboundSocketEvent[];
} {
  const gateway = new WebsocketGateway(new ContextService());
  const events: OutboundSocketEvent[] = [];
  jest.spyOn(gateway, 'emit').mockImplementation((event) => {
    events.push(event);
  });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  return { gateway, events };
}

describe('log traces', () => {
  it('tags every line inside a trace, including after awaits', async () => {
    const { gateway, events } = gatewayWithSpy();
    await withTrace('chat', 'Chat · “test login”', async () => {
      gateway.emitRunLog({ category: 'chat', message: 'first' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      gateway.emitRunLog({ category: 'suite', message: 'second' });
    });
    gateway.emitRunLog({ category: 'system', message: 'outside' });

    const logs = events.filter((event) => event.type === 'log');
    expect(logs[0]).toMatchObject({
      source: 'backend',
      traceKind: 'chat',
      traceLabel: 'Chat · “test login”',
    });
    expect(logs[1].type === 'log' && logs[1].traceId).toBe(
      logs[0].type === 'log' && logs[0].traceId,
    );
    expect(logs[2]).toMatchObject({ traceId: undefined });
  });

  it('relays Tursor-AI events with the trace label and safe fields only', async () => {
    const { gateway, events } = gatewayWithSpy();
    let traceId = '';
    await withTrace('context', 'Build code context', () => {
      gateway.emitRunLog({ category: 'context', message: 'start' });
      const first = events[0];
      traceId = first.type === 'log' ? (first.traceId ?? '') : '';
      return Promise.resolve();
    });
    events.length = 0;

    const relayed = gateway.relayAiLogs([
      {
        traceId,
        level: 'success',
        category: 'flowmap',
        message: 'x'.repeat(5000),
        durationMs: 812,
        meta: { routes: ['/login'] },
      },
      {
        traceId,
        level: 'shout',
        category: 'nope',
        message: 'kept as info/system',
      },
      { message: '' },
      'junk',
    ]);

    expect(relayed).toBe(2);
    expect(events[0]).toMatchObject({
      type: 'log',
      source: 'ai',
      level: 'success',
      category: 'flowmap',
      traceKind: 'context',
      traceLabel: 'Build code context',
      durationMs: 812,
    });
    expect(events[0].type === 'log' && events[0].message.length).toBe(2000);
    expect(events[1]).toMatchObject({ level: 'info', category: 'system' });
  });
});
