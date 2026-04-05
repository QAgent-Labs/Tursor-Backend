import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

type SocketEvent =
  | { type: 'step_update'; stepId: string; step: string; status: 'running' }
  | { type: 'step_result'; stepId: string; status: 'success' | 'fail' }
  | { type: 'log'; stepId: string; message: string }
  | { type: 'screenshot'; stepId: string; url: string }
  | { type: 'complete'; status: 'success' | 'fail' };

@WebSocketGateway({
  cors: { origin: '*' },
})
export class WebsocketGateway {
  @WebSocketServer()
  server!: Server;

  emit(event: SocketEvent) {
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
