import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: '*' });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url?.startsWith('/ws')) {
      console.log(`[HTTP] ${req.method} ${req.url}`);
    }
    next();
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Tursor Backend')
    .setDescription(
      'NestJS orchestrator for Tursor: WebSocket CDP runs, workspace context, ' +
        'and REST chat APIs (Extension → Backend → Tursor-AI).',
    )
    .setVersion('0.1.0')
    .addTag('chat', 'Conversation lifecycle, RAG-backed LLM, test generation')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 9090;
  await app.listen(port);
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`📚 Swagger UI at http://localhost:${port}/api`);
  console.log(
    `🔌 WebSocket (Socket.IO) at http://localhost:${port} with path /ws`,
  );
}
void bootstrap();
