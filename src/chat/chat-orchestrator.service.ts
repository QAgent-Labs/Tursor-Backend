import { BadRequestError, NotFoundError } from '../lib/http-error';
import { createLogger } from '../lib/logger';
import { ContextService } from '../context/context.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import type {
  WorkspaceAiConfig,
  WorkspaceSupabaseConfig,
} from '../context/workspace-config.types';
import type { CdpAction, CdpStepDefinition } from '../cdp/cdp-step.types';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { TursorAiRuntimeService } from '../tursor-ai/tursor-ai-runtime.service';
import { RunOrchestratorService } from '../websocket/run-orchestrator.service';
import type {
  ChatTurnResponse,
  ConversationDto,
  ConversationListItem,
  ConversationSummary,
} from './chat.types';
import { SupabaseChatService } from './supabase-chat.service';

type WorkspaceBundle = {
  workspacePath: string;
  supabase: WorkspaceSupabaseConfig;
  ai: WorkspaceAiConfig;
};

function parseSummary(raw: string): ConversationSummary {
  const empty: ConversationSummary = { case: '', plans: [] };
  const text = raw.trim();
  if (!text) {
    return empty;
  }
  try {
    const data = JSON.parse(text) as {
      case?: unknown;
      plans?: unknown;
    };
    const plans = Array.isArray(data.plans)
      ? data.plans.flatMap((item) => {
          if (!item || typeof item !== 'object') {
            return [];
          }
          const plan = item as { id?: unknown; title?: unknown };
          if (typeof plan.id !== 'string' || !plan.id) {
            return [];
          }
          return [
            {
              id: plan.id,
              title: typeof plan.title === 'string' ? plan.title : '',
            },
          ];
        })
      : [];
    return {
      case: typeof data.case === 'string' ? data.case : text,
      plans,
    };
  } catch {
    return { case: text, plans: [] };
  }
}

function asCdpSteps(raw: unknown): CdpStepDefinition[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const steps: CdpStepDefinition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return null;
    }
    const step = item as { id?: unknown; label?: unknown; actions?: unknown };
    if (
      typeof step.id !== 'string' ||
      !step.id ||
      typeof step.label !== 'string' ||
      !step.label ||
      !Array.isArray(step.actions) ||
      step.actions.length === 0
    ) {
      return null;
    }
    steps.push({
      id: step.id,
      label: step.label,
      actions: step.actions as CdpAction[],
    });
  }
  return steps;
}

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

  private async completeTurn(
    bundle: WorkspaceBundle,
    input: {
      message: string;
      mode: 'intro' | 'chat';
      conversation: ConversationDto;
    },
  ): Promise<{ reply: string; case: string; steps: CdpStepDefinition[] | null }> {
    await this.ensureTursorAiReady();
    const summary = parseSummary(input.conversation.summary);
    const latestPlan = summary.plans[summary.plans.length - 1];
    let latestSteps: CdpStepDefinition[] | null = null;
    if (latestPlan && input.mode === 'chat') {
      const stored = await this.supabaseChat.getCdpPlan(
        bundle.supabase.database,
        latestPlan.id,
      );
      latestSteps = stored?.steps?.length ? stored.steps : null;
    }

    const result = await this.tursorAi.chatCompletion({
      workspace_path: bundle.workspacePath,
      message: input.message,
      generation_model: bundle.ai.generationModel,
      api_key: bundle.ai.apiKey,
      mode: input.mode,
      case: summary.case,
      plans: summary.plans,
      latest_cdp_steps: latestSteps,
    });

    return {
      reply: result.reply || 'Something went wrong.',
      case: result.case || summary.case,
      steps: asCdpSteps(result.cdp_steps),
    };
  }

  async intro(requestedWorkspacePath?: string): Promise<ChatTurnResponse> {
    const workspacePath = this.resolveWorkspace(requestedWorkspacePath);
    const bundle = this.loadWorkspaceBundle(workspacePath);
    const conversation = await this.supabaseChat.createConversation(
      bundle.supabase.database,
      workspacePath,
    );

    const ai = await this.completeTurn(bundle, {
      message: 'intro',
      mode: 'intro',
      conversation,
    });

    const summary: ConversationSummary = { case: ai.case, plans: [] };
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversation.id,
      JSON.stringify(summary),
    );

    await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId: conversation.id,
      role: 'assistant',
      content: ai.reply,
      messageType: 'chat',
      metadata: { cdpStepsId: null },
    });

    return {
      conversationId: conversation.id,
      reply: ai.reply,
      cdpStepsId: null,
      summary,
    };
  }

  async postMessage(
    conversationId: string,
    userMessage: string,
    requestedWorkspacePath?: string,
  ): Promise<ChatTurnResponse> {
    const text = userMessage.trim();
    if (!text) {
      throw new BadRequestError('message must be non-empty');
    }
    if (!conversationId?.trim()) {
      throw new BadRequestError('conversationId is required');
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

    const ai = await this.completeTurn(bundle, {
      message: text,
      mode: 'chat',
      conversation,
    });

    const previous = parseSummary(conversation.summary);
    let cdpStepsId: string | null = null;
    const plans = [...previous.plans];
    if (ai.steps) {
      const saved = await this.supabaseChat.saveCdpPlan(
        bundle.supabase.database,
        {
          conversationId,
          workspacePath,
          title: ai.steps[0]?.label || 'CDP plan',
          steps: ai.steps,
        },
      );
      cdpStepsId = saved.id;
      plans.push({ id: saved.id, title: saved.title });
    }

    const summary: ConversationSummary = { case: ai.case, plans };
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversationId,
      JSON.stringify(summary),
    );

    await this.supabaseChat.insertMessage(bundle.supabase.database, {
      conversationId,
      role: 'assistant',
      content: ai.reply,
      messageType: 'chat',
      metadata: { cdpStepsId },
    });

    return {
      conversationId,
      reply: ai.reply,
      cdpStepsId,
      summary,
    };
  }

  async listConversations(
    requestedWorkspacePath?: string,
  ): Promise<{ conversations: ConversationListItem[] }> {
    const workspacePath = this.resolveWorkspace(requestedWorkspacePath);
    const bundle = this.loadWorkspaceBundle(workspacePath);
    const rows = await this.supabaseChat.listConversations(
      bundle.supabase.database,
      workspacePath,
    );
    return {
      conversations: rows.map((row) => ({
        id: row.id,
        summary: parseSummary(row.summary),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  async runCdpPlan(cdpStepsId: string): Promise<{ ok: true; cdpStepsId: string }> {
    const id = cdpStepsId?.trim();
    if (!id) {
      throw new BadRequestError('cdpStepsId is required');
    }
    const workspacePath = this.resolveWorkspace();
    const bundle = this.loadWorkspaceBundle(workspacePath);
    const plan = await this.supabaseChat.getCdpPlan(
      bundle.supabase.database,
      id,
    );
    if (!plan || plan.workspacePath !== workspacePath) {
      throw new NotFoundError(`CDP plan ${id} not found`);
    }
    if (!plan.steps.length) {
      throw new BadRequestError('CDP plan has no steps');
    }

    void this.runOrchestrator.startCdpRun(plan.steps);
    this.logger.log(`Started CDP plan ${id} (${plan.steps.length} steps)`);
    return { ok: true, cdpStepsId: id };
  }

  async getConversation(conversationId: string): Promise<{
    conversation: ConversationDto;
    summary: ConversationSummary;
    messages: Awaited<ReturnType<SupabaseChatService['listMessages']>>;
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
    return {
      conversation,
      summary: parseSummary(conversation.summary),
      messages,
    };
  }
}
