import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CdpModule } from './cdp/cdp.module';
import { HealthModule } from './health/health.module';
import { SessionModule } from './session/session.module';
import { TestModule } from './test/test.module';
import { WebsocketModule } from './websocket/websocket.module';
import { ContextModule } from './context/context.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HealthModule,
    SessionModule,
    TestModule,
    WebsocketModule,
    ContextModule,
    CdpModule,
    ChatModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
