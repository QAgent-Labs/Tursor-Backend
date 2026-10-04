import { CdpRunnerService } from './cdp/cdp-runner.service';
import { ScreenshotStorageService } from './cdp/screenshot-storage.service';
import { SupabaseScreenshotService } from './cdp/supabase-screenshot.service';
import { ChatOrchestratorService } from './chat/chat-orchestrator.service';
import { SupabaseChatService } from './chat/supabase-chat.service';
import { ContextService } from './context/context.service';
import { WorkspaceConfigValidator } from './context/workspace-config.validator';
import { TursorAiClient } from './tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from './tursor-ai/tursor-ai-runtime.service';
import { RunOrchestratorService } from './websocket/run-orchestrator.service';
import { WebsocketGateway } from './websocket/websocket.gateway';

export type AppContainer = {
  contextService: ContextService;
  validator: WorkspaceConfigValidator;
  tursorAiRuntime: TursorAiRuntimeService;
  tursorAi: TursorAiClient;
  screenshotStorage: ScreenshotStorageService;
  supabaseScreenshots: SupabaseScreenshotService;
  cdpRunner: CdpRunnerService;
  wsGateway: WebsocketGateway;
  runOrchestrator: RunOrchestratorService;
  supabaseChat: SupabaseChatService;
  chatOrchestrator: ChatOrchestratorService;
};

export function createContainer(): AppContainer {
  const contextService = new ContextService();
  const validator = new WorkspaceConfigValidator();
  const tursorAiRuntime = new TursorAiRuntimeService();
  const tursorAi = new TursorAiClient(tursorAiRuntime);
  const screenshotStorage = new ScreenshotStorageService();
  const supabaseScreenshots = new SupabaseScreenshotService();
  const cdpRunner = new CdpRunnerService(
    screenshotStorage,
    supabaseScreenshots,
  );
  const wsGateway = new WebsocketGateway(contextService);
  const runOrchestrator = new RunOrchestratorService(
    contextService,
    validator,
    tursorAiRuntime,
    tursorAi,
    cdpRunner,
    wsGateway,
  );
  wsGateway.setRunOrchestrator(runOrchestrator);

  const supabaseChat = new SupabaseChatService();
  const chatOrchestrator = new ChatOrchestratorService(
    contextService,
    validator,
    supabaseChat,
    tursorAi,
    tursorAiRuntime,
    runOrchestrator,
  );

  return {
    contextService,
    validator,
    tursorAiRuntime,
    tursorAi,
    screenshotStorage,
    supabaseScreenshots,
    cdpRunner,
    wsGateway,
    runOrchestrator,
    supabaseChat,
    chatOrchestrator,
  };
}
