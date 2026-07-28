import { NestFactory } from '@nestjs/core';
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

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 9090;
  await app.listen(port);
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(
    `🔌 WebSocket (Socket.IO) at http://localhost:${port} with path /ws`,
  );
}
void bootstrap();
