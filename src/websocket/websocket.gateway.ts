import { Inject, Logger, forwardRef } from '@nestjs/common';
import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ContextService } from '../context/context.service';
import { RunOrchestratorService } from './run-orchestrator.service';

export type OutboundSocketEvent =
  | { type: 'step_update'; stepId: string; step: string; status: 'running' }
  | { type: 'step_result'; stepId: string; status: 'success' | 'fail' }
  | { type: 'log'; stepId: string; message: string }
  | { type: 'screenshot'; stepId: string; url: string }
  | { type: 'complete'; status: 'success' | 'fail' }
  | { type: 'context_building' }
  | {
      type: 'context_ready';
    }
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

type StartContextEvent = {
  type: 'start_context';
};

type RevalidateContextEvent = {
  type: 'revalidate_context';
};

type UserMessageEvent = {
  type: 'user_message';
  id: string;
  text: string;
};

type InboundSocketEvent =
  | WorkspaceInitEvent
  | SessionConfigEvent
  | StartContextEvent
  | RevalidateContextEvent
  | UserMessageEvent;

@WebSocketGateway({
  path: '/ws',
  cors: { origin: '*' },
})
export class WebsocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebsocketGateway.name);

  constructor(
    private readonly contextService: ContextService,
    @Inject(forwardRef(() => RunOrchestratorService))
    private readonly runOrchestrator: RunOrchestratorService,
  ) {}

  @WebSocketServer()
  server!: Server;

  afterInit(): void {
    this.logger.log('WebSocket ready at path /ws (Socket.IO)');
    this.logger.log(
      'Client connect: io("http://127.0.0.1:9090", { path: "/ws" })',
    );
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);

    client.onAny((event, ...args) => {
      this.logger.log(
        `Event received [${client.id}] event="${event}" payload=${JSON.stringify(args)}`,
      );
    });
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.contextService.clearWorkspaceContext();
    this.logger.log('Workspace context cleared');
  }

  @SubscribeMessage('message')
  handleMessage(@MessageBody() data: InboundSocketEvent): void {
    this.logger.log(
      `SubscribeMessage("message") payload=${JSON.stringify(data)}`,
    );

    if (data?.type === 'workspace_init') {
      const port =
        typeof data.frontendPort === 'number' && data.frontendPort > 0
          ? data.frontendPort
          : undefined;
      this.contextService.setWorkspaceContext(data.workspacePath, port);
      this.logger.log(
        `Workspace context set: path=${data.workspacePath} frontendPort=${port ?? 'unset'}`,
      );
      return;
    }

    if (data?.type === 'session_config') {
      if (typeof data.workspacePath === 'string' && data.workspacePath.trim()) {
        const port =
          typeof data.frontendPort === 'number' && data.frontendPort > 0
            ? data.frontendPort
            : undefined;
        this.contextService.setWorkspaceContext(
          data.workspacePath.trim(),
          port,
        );
      } else if (
        typeof data.frontendPort === 'number' &&
        data.frontendPort > 0
      ) {
        this.contextService.setFrontendPort(data.frontendPort);
      }
      return;
    }

    if (data?.type === 'start_context' || data?.type === 'revalidate_context') {
      if (data.type === 'revalidate_context') {
        this.contextService.resetContextReady();
      }
      void this.runOrchestrator.startContextPipeline();
      return;
    }

    if (data?.type === 'user_message') {
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const id = typeof data.id === 'string' ? data.id : '';
      if (!text) {
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

      this.emit({
        type: 'log',
        stepId: 'chat',
        message: `User instruction received (${text.length} chars).`,
      });

      return;
    }

    this.logger.warn(
      `Unhandled message type: ${String((data as { type?: string })?.type)}`,
    );
  }

  emit(event: OutboundSocketEvent) {
    this.server.emit('message', event);
  }

  sendStepUpdate(stepId: string, step: string) {
    this.emit({
      type: 'step_update',
      stepId,
      step,
      status: 'running',
    });
  }

  sendStepResult(stepId: string, status: 'success' | 'fail') {
    this.emit({
      type: 'step_result',
      stepId,
      status,
    });
  }

  sendLog(stepId: string, message: string) {
    this.emit({
      type: 'log',
      stepId,
      message,
    });
  }

  sendScreenshot(stepId: string, url: string) {
    this.emit({
      type: 'screenshot',
      stepId,
      url,
    });
  }

  sendComplete(status: 'success' | 'fail') {
    this.emit({
      type: 'complete',
      status,
    });
  }
}
