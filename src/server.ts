import './lib/playwright-env';
import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import swaggerUi from 'swagger-ui-express';
import { createContainer } from './container';
import { config } from './lib/config';
import { createRoutes, errorMiddleware } from './routes';

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Tursor Backend',
    version: '0.1.0',
    description:
      'Express orchestrator for Tursor: WebSocket CDP runs, workspace context, and REST chat.',
  },
  paths: {
    '/health': { get: { summary: 'Health check' } },
    '/context/current': { get: { summary: 'Active workspace session' } },
    '/context/validate': { get: { summary: 'Validate workspace config' } },
    '/context/bootstrap': { post: { summary: 'Bootstrap workspace embeddings' } },
    '/context/update': { post: { summary: 'Queue incremental embed' } },
    '/chat/intro': { post: { summary: 'Start chat conversation' } },
    '/chat/message': { post: { summary: 'Send chat message' } },
    '/chat/approve-test-flow': { post: { summary: 'Approve test flow' } },
    '/chat/approve-execution': { post: { summary: 'Approve test execution' } },
    '/chat/conversations/{id}': { get: { summary: 'Get conversation' } },
  },
};

export async function startServer(): Promise<void> {
  const app = express();
  const container = createContainer();

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.use((req, _res, next) => {
    if (req.url?.startsWith('/ws')) {
      console.log(`[HTTP] ${req.method} ${req.url}`);
    }
    next();
  });

  app.use('/', createRoutes(container));
  app.use('/api', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  app.use(errorMiddleware);

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    path: '/ws',
    cors: { origin: '*' },
  });
  container.wsGateway.attach(io);

  await container.tursorAiRuntime.init();

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      console.log(`📚 Swagger UI at http://localhost:${config.port}/api`);
      console.log(
        `🔌 WebSocket (Socket.IO) at http://localhost:${config.port} with path /ws`,
      );
      resolve();
    });
  });
}

void startServer();
