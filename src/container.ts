import { CdpRunnerService } from './cdp/cdp-runner.service';
import { ScreenshotStorageService } from './cdp/screenshot-storage.service';
import { SupabaseScreenshotService } from './cdp/supabase-screenshot.service';
import { ChatOrchestratorService } from './chat/chat-orchestrator.service';
import { SupabaseChatService } from './chat/supabase-chat.service';
import { ReportService } from './suites/report.service';
import { SuiteService } from './suites/suite.service';
import { SupabaseSuiteService } from './suites/supabase-suite.service';
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
  supabaseSuites: SupabaseSuiteService;
  suites: SuiteService;
  reports: ReportService;
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
  const supabaseSuites = new SupabaseSuiteService();
  const suites = new SuiteService(
    supabaseSuites,
    supabaseScreenshots,
    screenshotStorage,
  );
  const reports = new ReportService(
    contextService,
    validator,
    suites,
    supabaseSuites,
    supabaseScreenshots,
    tursorAi,
    wsGateway,
  );
  suites.setPanelLog((payload) => wsGateway.emitRunLog(payload));
  const chatOrchestrator = new ChatOrchestratorService(
    contextService,
    validator,
    supabaseChat,
    supabaseSuites,
    suites,
    tursorAi,
    tursorAiRuntime,
    runOrchestrator,
    wsGateway,
  );
  runOrchestrator.setRunRecorder(chatOrchestrator);

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
    supabaseSuites,
    suites,
    reports,
    chatOrchestrator,
  };
}
