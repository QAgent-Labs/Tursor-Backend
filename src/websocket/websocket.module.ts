import { Module } from '@nestjs/common';
import { ContextModule } from '../context/context.module';
import { CdpModule } from '../cdp/cdp.module';
import { RunOrchestratorService } from './run-orchestrator.service';
import { WebsocketGateway } from './websocket.gateway';

@Module({
  imports: [ContextModule, CdpModule],
  providers: [WebsocketGateway, RunOrchestratorService],
  exports: [WebsocketGateway, RunOrchestratorService],
})
export class WebsocketModule {}
