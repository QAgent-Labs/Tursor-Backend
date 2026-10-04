import type { Server, Socket } from 'socket.io';
import { ContextService } from '../context/context.service';
import { createLogger } from '../lib/logger';
import type { RunOrchestratorService } from './run-orchestrator.service';
import {
  type RunLogCategory,
  type RunLogLevel,
  type RunLogPayload,
  type RunLogSocketEvent,
} from './run-log.types';

export type OutboundSocketEvent =
  | { type: 'step_update'; stepId: string; step: string; status: 'running' }
  | { type: 'step_result'; stepId: string; status: 'success' | 'fail' }
  | RunLogSocketEvent
  | { type: 'screenshot'; stepId: string; url: string }
  | { type: 'complete'; status: 'success' | 'fail' }
  | { type: 'context_building' }
  | { type: 'context_ready' }
  | {
      type: 'context_error';
      code: string;
      message: string;
    }
  | {
      type: 'chat';
      id: string;
      role: 'assistant';
      text: string;
      replyTo?: string;
    };

type WorkspaceInitEvent = {
  type: 'workspace_init';
  workspacePath: string;
  frontendPort?: number;
};

type SessionConfigEvent = {
  type: 'session_config';
  workspacePath?: string;
  frontendPort?: number;
};

type StartContextEvent = { type: 'start_context' };
type RevalidateContextEvent = { type: 'revalidate_context' };
type StartCdpEvent = { type: 'start_cdp' };
type UserMessageEvent = { type: 'user_message'; id: string; text: string };

type InboundSocketEvent =
  | WorkspaceInitEvent
  | SessionConfigEvent
  | StartContextEvent
  | RevalidateContextEvent
  | StartCdpEvent
  | UserMessageEvent;

export class WebsocketGateway {
  private readonly logger = createLogger('WebsocketGateway');
  private server: Server | null = null;
  private runOrchestrator: RunOrchestratorService | null = null;

  constructor(private readonly contextService: ContextService) {}

  setRunOrchestrator(runOrchestrator: RunOrchestratorService): void {
    this.runOrchestrator = runOrchestrator;
  }

  attach(server: Server): void {
    this.server = server;
    this.logger.log('WebSocket ready at path /ws (Socket.IO)');
    this.emitRunLog({
      category: 'system',
      level: 'info',
      message: 'WebSocket server initialized at path /ws.',
    });

    server.on('connection', (client: Socket) => {
      this.handleConnection(client);
      client.on('disconnect', () => this.handleDisconnect(client));
      client.on('message', (data: InboundSocketEvent) => {
        this.handleMessage(data);
      });
      client.onAny((event, ...args) => {
        this.logger.log(
          `Event received [${client.id}] event="${event}" payload=${JSON.stringify(args)}`,
        );
      });
    });
  }

  private handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    this.emitRunLog({
      category: 'connection',
      level: 'success',
      message: `Client connected (${client.id}).`,
      meta: { clientId: client.id },
    });
  }

  private handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.contextService.clearWorkspaceContext();
    this.emitRunLog({
      category: 'connection',
      level: 'warn',
      message: `Client disconnected (${client.id}). Workspace context cleared.`,
      meta: { clientId: client.id },
    });
  }

  handleMessage(data: InboundSocketEvent): void {
    this.logger.log(`SubscribeMessage("message") payload=${JSON.stringify(data)}`);

    const inboundType = (data as { type?: string })?.type ?? 'unknown';
    this.emitRunLog({
      category: 'connection',
      level: 'debug',
      message: `Inbound message received: ${inboundType}.`,
      meta: { inboundType },
    });

    const runOrchestrator = this.runOrchestrator;
    if (!runOrchestrator) {
      return;
    }

    if (data?.type === 'workspace_init') {
      const port =
        typeof data.frontendPort === 'number' && data.frontendPort > 0
          ? data.frontendPort
          : undefined;
      this.contextService.setWorkspaceContext(data.workspacePath, port);
      this.emitRunLog({
        category: 'context',
        level: 'info',
        message: `Workspace initialized: ${data.workspacePath}`,
        meta: { workspacePath: data.workspacePath, frontendPort: port ?? null },
      });
      if (port) {
        this.emitRunLog({
          category: 'context',
          level: 'info',
          message: `Frontend port set to ${port}.`,
          meta: { frontendPort: port },
        });
      }
      return;
    }

    if (data?.type === 'session_config') {
      if (typeof data.workspacePath === 'string' && data.workspacePath.trim()) {
        const port =
          typeof data.frontendPort === 'number' && data.frontendPort > 0
            ? data.frontendPort
            : undefined;
        this.contextService.setWorkspaceContext(data.workspacePath.trim(), port);
        this.emitRunLog({
          category: 'context',
          level: 'info',
          message: 'Session config updated (workspace + frontend).',
          meta: {
            workspacePath: data.workspacePath.trim(),
            frontendPort: port ?? null,
          },
        });
      } else if (
        typeof data.frontendPort === 'number' &&
        data.frontendPort > 0
      ) {
        this.contextService.setFrontendPort(data.frontendPort);
        this.emitRunLog({
          category: 'context',
          level: 'info',
          message: `Session config updated: frontend port ${data.frontendPort}.`,
          meta: { frontendPort: data.frontendPort },
        });
      } else {
        this.emitRunLog({
          category: 'context',
          level: 'warn',
          message: 'Session config received with no workspace or frontend port.',
        });
      }
      return;
    }

    if (data?.type === 'start_context' || data?.type === 'revalidate_context') {
      if (data.type === 'revalidate_context') {
        this.contextService.resetContextReady();
        this.emitRunLog({
          category: 'context',
          level: 'info',
          message: 'Context revalidation requested — resetting ready state.',
        });
      } else {
        this.emitRunLog({
          category: 'context',
          level: 'info',
          message: 'Context pipeline start requested.',
        });
      }
      void runOrchestrator.startContextPipeline();
      return;
    }

    if (data?.type === 'start_cdp') {
      this.emitRunLog({
        category: 'cdp',
        level: 'info',
        message: 'Run screen requested CDP demo start.',
      });
      void runOrchestrator.startCdpRun();
      return;
    }

    if (data?.type === 'user_message') {
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const id = typeof data.id === 'string' ? data.id : '';
      if (!text) {
        this.emitRunLog({
          category: 'chat',
          level: 'warn',
          message: 'Empty user message ignored.',
        });
        return;
      }

      const preview = text.length > 280 ? `${text.slice(0, 277)}…` : text;
      this.emit({
        type: 'chat',
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: `Understood. I'll queue this for the QA agent: "${preview}"`,
        replyTo: id || undefined,
      });
      this.emitRunLog({
        category: 'chat',
        level: 'info',
        message: `User instruction received (${text.length} chars).`,
        meta: { messageId: id || null, preview },
      });
      return;
    }

    this.logger.warn(
      `Unhandled message type: ${String((data as { type?: string })?.type)}`,
    );
    this.emitRunLog({
      category: 'error',
      level: 'warn',
      message: `Unhandled inbound message type: ${inboundType}.`,
      meta: { inboundType },
    });
  }

  emit(event: OutboundSocketEvent): void {
    this.server?.emit('message', event);
  }

  emitRunLog(payload: RunLogPayload): void {
    const level: RunLogLevel = payload.level ?? 'info';
    const event: RunLogSocketEvent = {
      type: 'log',
      category: payload.category,
      level,
      message: payload.message,
      timestamp: new Date().toISOString(),
      stepId: payload.stepId,
      meta: payload.meta,
    };

    if (level === 'error') {
      this.logger.error(`[${payload.category}] ${payload.message}`);
    } else if (level === 'warn') {
      this.logger.warn(`[${payload.category}] ${payload.message}`);
    } else if (level === 'debug') {
      this.logger.debug(`[${payload.category}] ${payload.message}`);
    } else {
      this.logger.log(`[${payload.category}] ${payload.message}`);
    }

    this.emit(event);
  }

  sendStepUpdate(stepId: string, step: string): void {
    this.emit({ type: 'step_update', stepId, step, status: 'running' });
    this.emitRunLog({
      category: 'step',
      level: 'info',
      message: `Running step: ${step}`,
      stepId,
      meta: { stepLabel: step },
    });
  }

  sendStepResult(stepId: string, status: 'success' | 'fail'): void {
    this.emit({ type: 'step_result', stepId, status });
    this.emitRunLog({
      category: 'step',
      level: status === 'success' ? 'success' : 'error',
      message: `Step ${status === 'success' ? 'completed' : 'failed'}.`,
      stepId,
      meta: { status },
    });
  }

  sendLog(stepId: string, message: string, category: RunLogCategory = 'cdp'): void {
    this.emitRunLog({
      category,
      level: message.toLowerCase().includes('failed') ? 'error' : 'info',
      message,
      stepId,
    });
  }

  sendScreenshot(stepId: string, url: string): void {
    this.emit({ type: 'screenshot', stepId, url });
    this.emitRunLog({
      category: 'screenshot',
      level: 'success',
      message: `Screenshot captured for step "${stepId}".`,
      stepId,
      meta: { url },
    });
  }

  sendComplete(status: 'success' | 'fail'): void {
    this.emit({ type: 'complete', status });
    this.emitRunLog({
      category: 'system',
      level: status === 'success' ? 'success' : 'error',
      message: `Run finished (${status === 'success' ? 'success' : 'failed'}).`,
      meta: { status },
    });
  }

  emitContextBuilding(): void {
    this.emit({ type: 'context_building' });
    this.emitRunLog({
      category: 'context',
      level: 'info',
      message: 'Code context is being created — please wait…',
    });
  }

  emitContextReady(): void {
    this.emit({ type: 'context_ready' });
    this.emitRunLog({
      category: 'context',
      level: 'success',
      message: 'Code context ready — you can start the test run.',
    });
  }

  emitContextError(code: string, message: string): void {
    this.emit({ type: 'context_error', code, message });
    this.emitRunLog({
      category: 'error',
      level: 'error',
      message,
      meta: { code },
    });
  }
}
