import { randomUUID } from 'node:crypto';
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
  CdpRunRecord,
  CdpRunStatus,
  ChatSuite,
  ChatTurnResponse,
  ConversationDto,
  ConversationListItem,
  ConversationSummary,
  SuiteCaseKind,
  SummaryPlan,
} from './chat.types';
import type { TursorAiChatResult } from '../tursor-ai/tursor-ai.client';
import { SupabaseChatService } from './supabase-chat.service';

type WorkspaceBundle = {
  workspacePath: string;
  supabase: WorkspaceSupabaseConfig;
  ai: WorkspaceAiConfig;
};

function emptySummary(): ConversationSummary {
  return { case: '', brief_summary: '', plans: [], cdp_runs: [] };
}

function parseScreenshots(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asKind(value: unknown): SuiteCaseKind | '' {
  if (value === 'success' || value === 'failure' || value === 'edge') {
    return value;
  }
  return '';
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asResponseId(value: string | undefined): string {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (value && uuid.test(value)) {
    return value;
  }
  return randomUUID();
}

function parseCdpRuns(raw: unknown): CdpRunRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const runs: CdpRunRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const run = item as {
      cdp_step_id?: unknown;
      case_id?: unknown;
      status?: unknown;
      status_message?: unknown;
      screenshots?: unknown;
      response_id?: unknown;
      feature?: unknown;
      title?: unknown;
      kind?: unknown;
    };
    if (typeof run.cdp_step_id !== 'string' || !run.cdp_step_id) {
      continue;
    }
    if (run.status !== 'passed' && run.status !== 'failure') {
      continue;
    }
    const caseId =
      typeof run.case_id === 'string' && run.case_id
        ? run.case_id
        : run.cdp_step_id;
    runs.push({
      cdp_step_id: run.cdp_step_id,
      case_id: caseId,
      status: run.status,
      status_message: asText(run.status_message),
      screenshots: parseScreenshots(run.screenshots),
      response_id: asText(run.response_id),
      feature: asText(run.feature),
      title: asText(run.title),
      kind: asKind(run.kind),
    });
  }
  return runs;
}

function parseSummary(raw: string): ConversationSummary {
  const text = raw.trim();
  if (!text) {
    return emptySummary();
  }
  try {
    const data = JSON.parse(text) as {
      case?: unknown;
      brief_summary?: unknown;
      plans?: unknown;
      cdp_runs?: unknown;
    };
    const plans: SummaryPlan[] = [];
    if (Array.isArray(data.plans)) {
      for (const item of data.plans) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const plan = item as {
          id?: unknown;
          title?: unknown;
          response_id?: unknown;
          feature?: unknown;
          kind?: unknown;
        };
        if (typeof plan.id !== 'string' || !plan.id) {
          continue;
        }
        plans.push({
          id: plan.id,
          title: asText(plan.title),
          response_id: asText(plan.response_id),
          feature: asText(plan.feature),
          kind: asKind(plan.kind),
        });
      }
    }
    return {
      case: typeof data.case === 'string' ? data.case : text,
      brief_summary:
        typeof data.brief_summary === 'string' ? data.brief_summary : '',
      plans,
      cdp_runs: parseCdpRuns(data.cdp_runs),
    };
  } catch {
    return { ...emptySummary(), case: text };
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

type GeneratedSuite = {
  feature: string;
  cases: Array<{
    kind: SuiteCaseKind;
    title: string;
    explanation: string;
    steps: CdpStepDefinition[];
  }>;
};

function asGeneratedSuite(raw: TursorAiChatResult['test_suite']): GeneratedSuite | null {
  if (!raw || typeof raw.feature !== 'string' || !raw.feature.trim()) {
    return null;
  }
  if (!Array.isArray(raw.cases)) {
    return null;
  }
  const success: GeneratedSuite['cases'] = [];
  const failure: GeneratedSuite['cases'] = [];
  const edges: GeneratedSuite['cases'] = [];
  for (const item of raw.cases) {
    const kind = asKind(item?.kind);
    if (!kind) {
      continue;
    }
    const steps = asCdpSteps(item.steps);
    if (!steps) {
      continue;
    }
    const title =
      typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : kind === 'failure'
          ? 'Failure test case'
          : kind === 'edge'
            ? 'Edge test case'
            : 'Success test case';
    const explanation =
      typeof item.explanation === 'string' ? item.explanation.trim() : '';
    const caseRow = { kind, title, explanation, steps };
    if (kind === 'success' && success.length === 0) {
      success.push(caseRow);
    } else if (kind === 'failure' && failure.length === 0) {
      failure.push(caseRow);
    } else if (kind === 'edge' && edges.length < 10) {
      edges.push(caseRow);
    }
  }
  const cases = [...success, ...failure, ...edges];
  if (!cases.length) {
    return null;
  }
  return { feature: raw.feature.trim(), cases };
}

function suiteFromLegacySteps(
  raw: TursorAiChatResult['cdp_steps'],
): GeneratedSuite | null {
  const steps = asCdpSteps(raw);
  if (!steps) {
    return null;
  }
  return {
    feature: 'Feature',
    cases: [
      {
        kind: 'success',
        title: 'Success test case',
        explanation: '',
        steps,
      },
    ],
  };
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

  private async loadLatestPlanContext(
    bundle: WorkspaceBundle,
    summary: ConversationSummary,
    mode: 'intro' | 'chat',
  ): Promise<{
    latestSteps: CdpStepDefinition[] | null;
    latestSuite: {
      response_id: string;
      feature: string;
      cases: Array<{
        id: string;
        kind: string;
        title: string;
        steps: CdpStepDefinition[];
      }>;
    } | null;
  }> {
    if (mode !== 'chat') {
      return { latestSteps: null, latestSuite: null };
    }
    const tagged = summary.plans.filter((plan) => plan.response_id);
    const responseId = tagged[tagged.length - 1]?.response_id;
    if (responseId) {
      const members = summary.plans.filter(
        (plan) => plan.response_id === responseId,
      );
      const cases: Array<{
        id: string;
        kind: string;
        title: string;
        steps: CdpStepDefinition[];
      }> = [];
      for (const plan of members) {
        const stored = await this.supabaseChat.getCdpPlan(
          bundle.supabase.database,
          plan.id,
        );
        if (!stored?.steps?.length) {
          continue;
        }
        cases.push({
          id: plan.id,
          kind: plan.kind,
          title: plan.title,
          steps: stored.steps,
        });
      }
      if (cases.length > 0) {
        return {
          latestSteps: null,
          latestSuite: {
            response_id: responseId,
            feature: members.find((plan) => plan.feature)?.feature ?? '',
            cases,
          },
        };
      }
    }
    const latestPlan = summary.plans[summary.plans.length - 1];
    if (!latestPlan) {
      return { latestSteps: null, latestSuite: null };
    }
    const stored = await this.supabaseChat.getCdpPlan(
      bundle.supabase.database,
      latestPlan.id,
    );
    return {
      latestSteps: stored?.steps?.length ? stored.steps : null,
      latestSuite: null,
    };
  }

  private async completeTurn(
    bundle: WorkspaceBundle,
    input: {
      message: string;
      mode: 'intro' | 'chat';
      conversation: ConversationDto;
    },
  ): Promise<{
    reply: string;
    case: string;
    brief_summary: string;
    responseId: string;
    suite: GeneratedSuite | null;
  }> {
    await this.ensureTursorAiReady();
    const summary = parseSummary(input.conversation.summary);
    const latest = await this.loadLatestPlanContext(
      bundle,
      summary,
      input.mode,
    );

    const result = await this.tursorAi.chatCompletion({
      conversation_id: input.conversation.id,
      workspace_path: bundle.workspacePath,
      message: input.message,
      generation_model: bundle.ai.generationModel,
      api_key: bundle.ai.apiKey,
      mode: input.mode,
      case: summary.case,
      brief_summary: summary.brief_summary,
      plans: summary.plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        response_id: plan.response_id,
        feature: plan.feature,
        kind: plan.kind,
      })),
      cdp_runs: summary.cdp_runs.map((run) => ({
        cdp_step_id: run.cdp_step_id,
        status: run.status,
        status_message: run.status_message,
        response_id: run.response_id,
        feature: run.feature,
        case_id: run.case_id,
        title: run.title,
        kind: run.kind,
      })),
      latest_cdp_steps: latest.latestSteps,
      latest_test_suite: latest.latestSuite,
    });

    return {
      reply: result.reply || 'Something went wrong.',
      case: result.case || summary.case,
      brief_summary: result.brief_summary || summary.brief_summary,
      responseId: asResponseId(result.response_id),
      suite: asGeneratedSuite(result.test_suite) ?? suiteFromLegacySteps(result.cdp_steps),
    };
  }

  private async saveSuitePlans(
    bundle: WorkspaceBundle,
    conversationId: string,
    responseId: string,
    suite: GeneratedSuite | null,
  ): Promise<{ plans: SummaryPlan[]; chatSuite: ChatSuite | null }> {
    if (!suite) {
      return { plans: [], chatSuite: null };
    }
    const plans: SummaryPlan[] = [];
    const cases: ChatSuite['cases'] = [];
    for (const testCase of suite.cases) {
      const saved = await this.supabaseChat.saveCdpPlan(
        bundle.supabase.database,
        {
          conversationId,
          workspacePath: bundle.workspacePath,
          title: testCase.title,
          steps: testCase.steps,
        },
      );
      plans.push({
        id: saved.id,
        title: testCase.title,
        response_id: responseId,
        feature: suite.feature,
        kind: testCase.kind,
      });
      cases.push({
        id: saved.id,
        kind: testCase.kind,
        title: testCase.title,
        explanation: testCase.explanation,
      });
    }
    return {
      plans,
      chatSuite: { feature: suite.feature, cases },
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

    const summary: ConversationSummary = {
      case: ai.case,
      brief_summary: ai.brief_summary,
      plans: [],
      cdp_runs: [],
    };
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversation.id,
      JSON.stringify(summary),
    );

    const saved = await this.supabaseChat.insertMessage(
      bundle.supabase.database,
      {
        id: ai.responseId,
        conversationId: conversation.id,
        role: 'assistant',
        content: ai.reply,
        messageType: 'chat',
        metadata: {
          response_id: ai.responseId,
          conversation_id: conversation.id,
        },
      },
    );

    return {
      conversationId: conversation.id,
      responseId: saved.id,
      reply: ai.reply,
      suite: null,
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

    const savedSuite = await this.saveSuitePlans(
      bundle,
      conversationId,
      ai.responseId,
      ai.suite,
    );

    const latest = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    const stored = parseSummary(latest?.summary ?? conversation.summary);
    const summary: ConversationSummary = {
      case: ai.case,
      brief_summary: ai.brief_summary || stored.brief_summary,
      plans: [...stored.plans, ...savedSuite.plans],
      cdp_runs: stored.cdp_runs,
    };
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversationId,
      JSON.stringify(summary),
    );

    const saved = await this.supabaseChat.insertMessage(
      bundle.supabase.database,
      {
        id: ai.responseId,
        conversationId,
        role: 'assistant',
        content: ai.reply,
        messageType: 'chat',
        metadata: {
          response_id: ai.responseId,
          conversation_id: conversationId,
          ...(savedSuite.chatSuite
            ? {
                feature: savedSuite.chatSuite.feature,
                cases: savedSuite.chatSuite.cases,
              }
            : {}),
        },
      },
    );

    return {
      conversationId,
      responseId: saved.id,
      reply: ai.reply,
      suite: savedSuite.chatSuite,
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

  async runCdpPlan(
    cdpStepsId: string,
    conversationId: string,
  ): Promise<{ ok: true; cdpStepsId: string }> {
    const id = cdpStepsId?.trim();
    const conversation = conversationId?.trim();
    if (!id) {
      throw new BadRequestError('cdpStepsId is required');
    }
    if (!conversation) {
      throw new BadRequestError('conversationId is required');
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
    if (plan.conversationId !== conversation) {
      throw new BadRequestError(
        'CDP plan belongs to a different conversation.',
      );
    }
    if (!plan.steps.length) {
      throw new BadRequestError('CDP plan has no steps');
    }

    void this.runOrchestrator.startCdpRun(plan.steps, conversation, id);
    this.logger.log(`Started CDP plan ${id} (${plan.steps.length} steps)`);
    return { ok: true, cdpStepsId: id };
  }

  async recordCdpRun(
    conversationId: string,
    cdpStepId: string,
    status: CdpRunStatus,
    statusMessage = '',
    screenshots: string[] = [],
  ): Promise<void> {
    const workspacePath = this.contextService.getWorkspacePath()?.trim();
    if (!workspacePath || !conversationId || !cdpStepId) {
      return;
    }
    const bundle = this.loadWorkspaceBundle(workspacePath);
    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation || conversation.workspacePath !== workspacePath) {
      return;
    }
    const summary = parseSummary(conversation.summary);
    const plan = summary.plans.find((item) => item.id === cdpStepId);
    summary.cdp_runs.push({
      cdp_step_id: cdpStepId,
      case_id: cdpStepId,
      status,
      status_message: statusMessage.trim(),
      screenshots,
      response_id: plan?.response_id ?? '',
      feature: plan?.feature ?? '',
      title: plan?.title ?? '',
      kind: plan?.kind ?? '',
    });
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversationId,
      JSON.stringify(summary),
    );
    this.logger.log(
      `Recorded CDP run ${cdpStepId} as ${status} on ${conversationId}`,
    );
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
