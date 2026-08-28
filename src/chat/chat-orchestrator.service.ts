import {
  BadRequestError,
  NotFoundError,
} from '../lib/http-error';
import { createLogger } from '../lib/logger';
import { ContextService } from '../context/context.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import type {
  WorkspaceAiConfig,
  WorkspaceSupabaseConfig,
} from '../context/workspace-config.types';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from '../tursor-ai/tursor-ai-runtime.service';
import { RunOrchestratorService } from '../websocket/run-orchestrator.service';
import type {
  AiStructuredResponse,
  ChatMessageDto,
  ConversationDto,
  ConversationStatus,
  GeneratedTestDto,
  MessageType,
  TestFlowStep,
} from './chat.types';
import {
  canApproveTestFlow,
  canExecuteTest,
  nextStatusAfterAiResponse,
} from './conversation-state';
import { SupabaseChatService } from './supabase-chat.service';

const RECENT_MESSAGE_WINDOW = 16;

type WorkspaceBundle = {
  workspacePath: string;
  supabase: WorkspaceSupabaseConfig;
  ai: WorkspaceAiConfig;
};

export class ChatOrchestratorService {
  private readonly logger = createLogger('ChatOrchestratorService');

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    private readonly supabaseChat: SupabaseChatService,
    private readonly tursorAi: TursorAiClient,
    private readonly tursorAiRuntime: TursorAiRuntimeService,
    private readonly runOrchestrator: RunOrchestratorService,
  ) {}

  private resolveWorkspace(requestedPath?: string): string {
    const active = this.contextService.getWorkspacePath();
    const path = (requestedPath?.trim() || active || '').trim();
    if (!path) {
      throw new BadRequestError(
        'No workspace path. Connect from the extension or pass workspacePath.',
      );
    }
    if (active && requestedPath?.trim() && path !== active) {
      throw new BadRequestError(
        'workspacePath does not match the active Tursor session workspace.',
      );
    }
    if (!active && requestedPath?.trim()) {
      this.contextService.setWorkspaceContext(path);
    }
    return path;
  }

  private loadWorkspaceBundle(workspacePath: string): WorkspaceBundle {
    const validated = this.validator.validate(workspacePath);
    if (!validated.ok) {
      throw new BadRequestError(validated.error);
    }
    if (!validated.ai) {
      throw new BadRequestError(
        'Missing required "ai" object in .tursor/config.json (generationModel, apiKey).',
      );
    }
    return {
      workspacePath,
      supabase: validated.supabase,
      ai: validated.ai,
    };
  }

  private async ensureTursorAiReady(): Promise<void> {
    await this.tursorAiRuntime.refresh();
    if (this.tursorAiRuntime.isReachable()) {
      return;
    }
    const started = await this.tursorAiRuntime.tryStartViaCli();
    if (!started) {
      throw new BadRequestError(
        'Tursor-AI is not reachable. Run tursorAI start or complete install.',
      );
    }
  }

  private mapAiResult(result: {
    type: string;
    content?: string;
    status?: string;
    testFlow?: TestFlowStep[];
    language?: string;
    framework?: string;
    testName?: string;
    code?: string;
    retrieved_chunk_count?: number;
  }): AiStructuredResponse {
    return {
      type: result.type as AiStructuredResponse['type'],
      content: result.content,
      status: result.status,
      testFlow: result.testFlow,
      language: result.language,
      framework: result.framework,
      testName: result.testName,
      code: result.code,
      retrievedChunkCount: result.retrieved_chunk_count,
    };
  }

  private messageTypeFromAi(ai: AiStructuredResponse): MessageType {
    if (ai.type === 'test_proposal') return 'test_proposal';
    if (ai.type === 'test_generation') return 'test_generation';
    return 'chat';
  }

  private metadataFromAi(ai: AiStructuredResponse): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      aiType: ai.type,
      status: ai.status,
      retrievedChunkCount: ai.retrievedChunkCount ?? 0,
    };
    if (ai.testFlow) {
      meta.testFlow = ai.testFlow;
    }
    if (ai.code) {
      meta.language = ai.language;
      meta.framework = ai.framework;
      meta.testName = ai.testName;
    }
    return meta;
  }

  private recentMessagesForLlm(messages: ChatMessageDto[]) {
    return messages.slice(-RECENT_MESSAGE_WINDOW).map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  private async callTursorAiChat(
    bundle: WorkspaceBundle,
    input: {
      message: string;
      mode: 'chat' | 'intro' | 'generate_test';
      conversation: ConversationDto;
      messages: ChatMessageDto[];
      approvedTestFlow?: TestFlowStep[] | null;
    },
  ): Promise<AiStructuredResponse> {
    await this.ensureTursorAiReady();

    const result = await this.tursorAi.chatCompletion({
      workspace_path: bundle.workspacePath,
      message: input.message,
      generation_model: bundle.ai.generationModel,
      api_key: bundle.ai.apiKey,
      mode: input.mode,
      conversation_state: input.conversation.status,
      conversation_summary: input.conversation.summary || null,
      recent_messages: this.recentMessagesForLlm(input.messages),
      approved_test_flow: input.approvedTestFlow ?? null,
      rag_query: input.mode === 'generate_test' ? input.message : undefined,
    });

    return this.mapAiResult(result);
  }

  async intro(requestedWorkspacePath?: string): Promise<{
    conversation: ConversationDto;
    message: ChatMessageDto;
    ai: AiStructuredResponse;
  }> {
    const workspacePath = this.resolveWorkspace(requestedWorkspacePath);
    const bundle = this.loadWorkspaceBundle(workspacePath);

    const conversation = await this.supabaseChat.createConversation(
      bundle.supabase.database,
      workspacePath,
    );

    const ai = await this.callTursorAiChat(bundle, {
      message: 'intro',
      mode: 'intro',
      conversation,
      messages: [],
    });

    const assistant = await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId: conversation.id,
      role: 'assistant',
      content: ai.content ?? 'Hello! How can I help you test this codebase?',
      messageType: this.messageTypeFromAi(ai),
      metadata: this.metadataFromAi(ai),
    });

    return { conversation, message: assistant, ai };
  }

  async postMessage(
    conversationId: string,
    userMessage: string,
    requestedWorkspacePath?: string,
  ): Promise<{
    conversation: ConversationDto;
    message: ChatMessageDto;
    ai: AiStructuredResponse;
  }> {
    const text = userMessage.trim();
    if (!text) {
      throw new BadRequestError('message must be non-empty');
    }

    const workspacePath = this.resolveWorkspace(requestedWorkspacePath);
    const bundle = this.loadWorkspaceBundle(workspacePath);

    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }
    if (conversation.workspacePath !== workspacePath) {
      throw new BadRequestError(
        'Conversation belongs to a different workspace. Start a new conversation.',
      );
    }

    if (!this.contextService.isContextReady()) {
      throw new BadRequestError(
        'Workspace context is not ready. Wait for embeddings to finish (context_ready).',
      );
    }

    await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'user',
      content: text,
      messageType: 'chat',
    });

    const history = await this.supabaseChat.listMessages(
      bundle.supabase.database,
      conversationId,
    );

    const ai = await this.callTursorAiChat(bundle, {
      message: text,
      mode: 'chat',
      conversation,
      messages: history,
    });

    const nextStatus = nextStatusAfterAiResponse(conversation.status, ai.type);
    await this.supabaseChat.updateConversationStatus(
      bundle.supabase.database,
      conversationId,
      nextStatus,
    );

    const assistant = await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'assistant',
      content:
        ai.content ??
        (ai.type === 'error' ? 'Something went wrong.' : 'OK.'),
      messageType: this.messageTypeFromAi(ai),
      metadata: this.metadataFromAi(ai),
    });

    const updated = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );

    return {
      conversation: updated ?? { ...conversation, status: nextStatus },
      message: assistant,
      ai,
    };
  }

  async approveTestFlow(conversationId: string): Promise<{
    conversation: ConversationDto;
    message: ChatMessageDto;
    ai: AiStructuredResponse;
    generatedTest: GeneratedTestDto;
  }> {
    const workspacePath = this.resolveWorkspace();
    const bundle = this.loadWorkspaceBundle(workspacePath);

    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }
    if (!canApproveTestFlow(conversation.status)) {
      throw new BadRequestError(
        `Conversation is not awaiting test approval (status=${conversation.status}).`,
      );
    }

    const history = await this.supabaseChat.listMessages(
      bundle.supabase.database,
      conversationId,
    );
    const approvedFlow = this.supabaseChat.extractApprovedTestFlow(history);
    if (!approvedFlow) {
      throw new BadRequestError(
        'No test proposal found in conversation history.',
      );
    }

    await this.supabaseChat.updateConversationStatus(
      bundle.supabase.database,
      conversationId,
      'GENERATING_TEST',
    );

    await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'user',
      content: 'Yes, generate the Playwright test for the proposed flow.',
      messageType: 'test_approval',
      metadata: { approvedTestFlow: approvedFlow },
    });

    const ai = await this.callTursorAiChat(bundle, {
      message: 'Generate the approved Playwright test.',
      mode: 'generate_test',
      conversation: { ...conversation, status: 'GENERATING_TEST' },
      messages: history,
      approvedTestFlow: approvedFlow,
    });

    if (ai.type !== 'test_generation' || !ai.code) {
      throw new BadRequestError(
        ai.content ?? 'Test generation did not return Playwright code.',
      );
    }

    const generatedTest = await this.supabaseChat.saveGeneratedTest(
      bundle.supabase.database,
      {
        conversationId,
        workspacePath,
        testName: ai.testName ?? null,
        language: ai.language ?? 'typescript',
        framework: ai.framework ?? 'playwright',
        code: ai.code,
      },
    );

    await this.supabaseChat.updateConversationStatus(
      bundle.supabase.database,
      conversationId,
      'TEST_GENERATED',
    );

    const assistant = await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'assistant',
      content: ai.content ?? 'Generated Playwright test.',
      messageType: 'test_generation',
      metadata: {
        ...this.metadataFromAi(ai),
        generatedTestId: generatedTest.id,
      },
    });

    const updated = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );

    return {
      conversation: updated ?? conversation,
      message: assistant,
      ai,
      generatedTest,
    };
  }

  async approveExecution(conversationId: string): Promise<{
    conversation: ConversationDto;
    generatedTest: GeneratedTestDto;
    executionStarted: boolean;
  }> {
    const workspacePath = this.resolveWorkspace();
    const bundle = this.loadWorkspaceBundle(workspacePath);

    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }
    if (!canExecuteTest(conversation.status)) {
      throw new BadRequestError(
        `Conversation is not ready for execution (status=${conversation.status}).`,
      );
    }

    const generatedTest = await this.supabaseChat.getLatestGeneratedTest(
      bundle.supabase.database,
      conversationId,
    );
    if (!generatedTest) {
      throw new BadRequestError('No generated test found for conversation.');
    }

    await this.supabaseChat.updateConversationStatus(
      bundle.supabase.database,
      conversationId,
      'EXECUTING',
    );

    await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'user',
      content: 'Approve and run the generated test.',
      messageType: 'test_approval',
      metadata: { generatedTestId: generatedTest.id },
    });

    // Phase 1: run existing demo CDP flow via WebSocket events.
    // Generated test code is persisted; dynamic runner executes it in a later phase.
    void this.runOrchestrator.startCdpRun();

    const updated = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );

    return {
      conversation: updated ?? conversation,
      generatedTest,
      executionStarted: true,
    };
  }

  async getConversation(conversationId: string): Promise<{
    conversation: ConversationDto;
    messages: ChatMessageDto[];
    generatedTest: GeneratedTestDto | null;
  }> {
    const workspacePath = this.resolveWorkspace();
    const bundle = this.loadWorkspaceBundle(workspacePath);

    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }

    const messages = await this.supabaseChat.listMessages(
      bundle.supabase.database,
      conversationId,
    );
    const generatedTest = await this.supabaseChat.getLatestGeneratedTest(
      bundle.supabase.database,
      conversationId,
    );

    return { conversation, messages, generatedTest };
  }
}
