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
import {
  RunOrchestratorService,
  runStamp,
  type CaseRunItem,
  type RunContext,
  type RunOutcome,
  type RunRecorder,
} from '../websocket/run-orchestrator.service';
import type {
  CdpRunRecord,
  CdpRunStatus,
  ChatPrdResult,
  ChatSuite,
  ChatTurnResponse,
  ConversationDto,
  ConversationListItem,
  ConversationSummary,
  SuiteCaseKind,
  SummaryPlan,
} from './chat.types';
import type {
  TursorAiChatRequest,
  TursorAiChatResult,
} from '../tursor-ai/tursor-ai.client';
import { SupabaseChatService } from './supabase-chat.service';
import { SupabaseSuiteService } from '../suites/supabase-suite.service';
import { moduleSlug, slugify, SuiteService } from '../suites/suite.service';
import type { NewSuiteCase, SuiteDetail } from '../suites/suite.types';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import type { RunLogPayload } from '../websocket/run-log.types';

type WorkspaceBundle = {
  workspacePath: string;
  supabase: WorkspaceSupabaseConfig;
  ai: WorkspaceAiConfig;
};

/** How long a chat turn waits for a code context build that is in progress. */
const CONTEXT_WAIT_MS = 90_000;
const INTENT_SUITE_REUSED = 'suite_reused';
const INTENT_SUITE_STATUS = 'suite_status';
const PENDING_ACTIONS = new Set([
  'generate',
  'reuse',
  'new_version',
  'collect_generate',
  'collect_new_version',
]);

function asPendingAction(
  value: unknown,
): ConversationSummary['pending_action'] {
  return typeof value === 'string' && PENDING_ACTIONS.has(value)
    ? (value as ConversationSummary['pending_action'])
    : '';
}

function emptySummary(): ConversationSummary {
  return {
    case: '',
    brief_summary: '',
    plans: [],
    cdp_runs: [],
    intent: '',
    focus_paths: [],
    active_suite_id: '',
    pending_action: '',
    pending_suite_id: '',
    prd_id: '',
  };
}

function parseScreenshots(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function asResponseId(value: string | undefined): string {
  return isUuid(value) ? value : randomUUID();
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
      suite_id?: unknown;
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
      suite_id: asText(run.suite_id),
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
      intent?: unknown;
      focus_paths?: unknown;
      active_suite_id?: unknown;
      pending_action?: unknown;
      pending_suite_id?: unknown;
      pending_reuse_suite_id?: unknown;
      prd_id?: unknown;
    };
    // Summaries from before the explain-and-confirm flow kept only a reuse offer.
    const legacyReuse = asText(data.pending_reuse_suite_id);
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
          suite_id?: unknown;
          version?: unknown;
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
          suite_id: asText(plan.suite_id),
          version: typeof plan.version === 'number' ? plan.version : 0,
        });
      }
    }
    return {
      case: typeof data.case === 'string' ? data.case : text,
      brief_summary:
        typeof data.brief_summary === 'string' ? data.brief_summary : '',
      plans,
      cdp_runs: parseCdpRuns(data.cdp_runs),
      intent: typeof data.intent === 'string' ? data.intent : '',
      focus_paths: Array.isArray(data.focus_paths)
        ? data.focus_paths.filter(
            (path): path is string => typeof path === 'string',
          )
        : [],
      active_suite_id: asText(data.active_suite_id),
      pending_action:
        asPendingAction(data.pending_action) || (legacyReuse ? 'reuse' : ''),
      pending_suite_id: asText(data.pending_suite_id) || legacyReuse,
      prd_id: asText(data.prd_id),
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
  moduleKey: string;
  moduleName: string;
  cases: NewSuiteCase[];
};

const MAX_SUITE_CASES = 40;

function asGeneratedSuite(
  raw: TursorAiChatResult['test_suite'],
): GeneratedSuite | null {
  if (!raw || typeof raw.feature !== 'string' || !raw.feature.trim()) {
    return null;
  }
  if (!Array.isArray(raw.cases)) {
    return null;
  }
  const order: SuiteCaseKind[] = ['success', 'failure', 'edge'];
  const cases: NewSuiteCase[] = [];
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
    cases.push({
      kind,
      title,
      explanation:
        typeof item.explanation === 'string' ? item.explanation.trim() : '',
      steps,
      requirementIds: Array.isArray(item.requirement_ids)
        ? item.requirement_ids.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : [],
    });
  }
  cases.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (!cases.length) {
    return null;
  }
  const feature = raw.feature.trim();
  const moduleKey =
    typeof raw.module_key === 'string' && raw.module_key.trim()
      ? raw.module_key.trim()
      : `feature:${slugify(feature)}`;
  return {
    feature,
    moduleKey,
    moduleName:
      typeof raw.module_name === 'string' && raw.module_name.trim()
        ? raw.module_name.trim()
        : feature,
    cases: cases.slice(0, MAX_SUITE_CASES),
  };
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
    moduleKey: 'feature:feature',
    moduleName: 'Feature',
    cases: [
      {
        kind: 'success',
        title: 'Success test case',
        explanation: '',
        steps,
        requirementIds: [],
      },
    ],
  };
}

function chatSuiteFrom(detail: SuiteDetail, reused: boolean): ChatSuite {
  return {
    feature: detail.suite.feature || detail.module.name,
    suiteId: detail.suite.id,
    version: detail.suite.version,
    moduleKey: detail.module.moduleKey,
    moduleName: detail.module.name,
    reused,
    cases: detail.cases.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      explanation: item.explanation,
      requirementIds: item.requirementIds,
    })),
  };
}

function plansFrom(detail: SuiteDetail, responseId: string): SummaryPlan[] {
  return detail.cases.map((item) => ({
    id: item.id,
    title: item.title,
    response_id: responseId,
    feature: detail.suite.feature || detail.module.name,
    kind: item.kind,
    suite_id: detail.suite.id,
    version: detail.suite.version,
  }));
}

export class ChatOrchestratorService implements RunRecorder {
  private readonly logger = createLogger('ChatOrchestratorService');

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    private readonly supabaseChat: SupabaseChatService,
    private readonly supabaseSuites: SupabaseSuiteService,
    private readonly suites: SuiteService,
    private readonly tursorAi: TursorAiClient,
    private readonly tursorAiRuntime: TursorAiRuntimeService,
    private readonly runOrchestrator: RunOrchestratorService,
    private readonly gateway: WebsocketGateway,
  ) {}

  private log(payload: RunLogPayload): void {
    this.gateway.emitRunLog({
      ...payload,
      category: payload.category ?? 'chat',
    });
  }

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

  loadWorkspaceBundle(workspacePath: string): WorkspaceBundle {
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

  /** The active workspace's config, for callers outside chat (reports). */
  activeBundle(): WorkspaceBundle {
    return this.loadWorkspaceBundle(this.resolveWorkspace());
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

  /** The suite the model should build on: the one offered, or the one in use here. */
  private async loadWorkingSuite(
    bundle: WorkspaceBundle,
    summary: ConversationSummary,
  ): Promise<TursorAiChatRequest['latest_test_suite']> {
    const suiteId = summary.pending_suite_id || summary.active_suite_id;
    if (!suiteId) {
      return null;
    }
    const detail = await this.suites.getDetail(
      bundle.supabase.database,
      suiteId,
      { withRuns: false },
    );
    if (!detail || detail.suite.workspacePath !== bundle.workspacePath) {
      return null;
    }
    return {
      response_id: '',
      suite_id: detail.suite.id,
      module_key: detail.module.moduleKey,
      version: detail.suite.version,
      feature: detail.suite.feature || detail.module.name,
      cases: detail.cases.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        steps: item.steps,
        requirement_ids: item.requirementIds,
      })),
    };
  }

  /** Conversations from before versioned suites keep their plans in cdp_plans. */
  private async loadLegacyPlanContext(
    bundle: WorkspaceBundle,
    summary: ConversationSummary,
  ): Promise<{
    latestSteps: CdpStepDefinition[] | null;
    latestSuite: TursorAiChatRequest['latest_test_suite'];
  }> {
    const legacy = summary.plans.filter((plan) => !plan.suite_id);
    const tagged = legacy.filter((plan) => plan.response_id);
    const responseId = tagged[tagged.length - 1]?.response_id;
    if (responseId) {
      const members = legacy.filter((plan) => plan.response_id === responseId);
      const cases: NonNullable<
        TursorAiChatRequest['latest_test_suite']
      >['cases'] = [];
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
    const latestPlan = legacy[legacy.length - 1];
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

  private async loadPrdContext(
    bundle: WorkspaceBundle,
    summary: ConversationSummary,
  ): Promise<TursorAiChatRequest['prd']> {
    if (!summary.prd_id) {
      return null;
    }
    const prd = await this.supabaseSuites.getPrd(
      bundle.supabase.database,
      summary.prd_id,
    );
    if (!prd || prd.workspacePath !== bundle.workspacePath) {
      return null;
    }
    return {
      prd_id: prd.id,
      title: prd.title,
      requirements: prd.requirements.map((item) => ({
        id: item.id,
        text: item.text,
        status: item.status,
      })),
    };
  }

  private async completeTurn(
    bundle: WorkspaceBundle,
    input: {
      message: string;
      mode: 'intro' | 'chat';
      conversation: ConversationDto;
    },
  ): Promise<TursorAiChatResult & { responseId: string }> {
    await this.ensureTursorAiReady();
    const summary = parseSummary(input.conversation.summary);
    const chat = input.mode === 'chat';
    const working = chat ? await this.loadWorkingSuite(bundle, summary) : null;
    const legacy =
      chat && !working
        ? await this.loadLegacyPlanContext(bundle, summary)
        : { latestSteps: null, latestSuite: null };
    const existing = chat
      ? await this.suites.listExisting(
          bundle.supabase.database,
          bundle.workspacePath,
        )
      : [];
    const prd = chat ? await this.loadPrdContext(bundle, summary) : null;
    if (chat) {
      this.log({
        category: 'chat',
        level: 'debug',
        message:
          `Sending the turn to Tursor-AI: ${existing.length} existing suite(s)` +
          (working
            ? `, working on v${working.version} of ${working.module_key}`
            : '') +
          (summary.pending_action
            ? `, waiting for an answer to “${summary.pending_action}”`
            : '') +
          (prd ? `, PRD “${prd.title}” linked` : '') +
          '.',
        meta: {
          existingSuites: existing.length,
          workingSuiteId: working?.suite_id ?? null,
          prdId: prd?.prd_id ?? null,
        },
      });
    }

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
      latest_cdp_steps: legacy.latestSteps,
      latest_test_suite: working ?? legacy.latestSuite,
      intent: summary.intent,
      focus_paths: summary.focus_paths,
      existing_suites: existing,
      pending_action: summary.pending_action,
      pending_suite_id: summary.pending_suite_id,
      active_suite_id: summary.active_suite_id,
      prd,
    });

    return {
      ...result,
      reply: result.reply || 'Something went wrong.',
      case: result.case || summary.case,
      brief_summary: result.brief_summary || summary.brief_summary,
      intent: result.intent || summary.intent,
      focus_paths: result.focus_paths ?? summary.focus_paths,
      responseId: asResponseId(result.response_id),
    };
  }

  /** Keep a fresh verdict on the suite, so an unchanged flow is not re-reviewed. */
  private async storeSuiteCheck(
    bundle: WorkspaceBundle,
    check: TursorAiChatResult['suite_check'],
  ): Promise<void> {
    if (!check || check.reused || !check.suite_id || !check.fingerprint) {
      return;
    }
    if (!isUuid(check.suite_id)) {
      return;
    }
    const { fingerprint, reused: _reused, ...result } = check;
    try {
      await this.supabaseSuites.saveSuiteCheck(
        bundle.supabase.database,
        check.suite_id,
        fingerprint,
        result,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log({
        category: 'suite',
        level: 'warn',
        message: `Could not store the suite check: ${detail}`,
      });
    }
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
      ...emptySummary(),
      case: ai.case ?? '',
      brief_summary: ai.brief_summary ?? '',
      intent: ai.intent ?? '',
      focus_paths: ai.focus_paths ?? [],
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
    const startedAt = Date.now();
    const text = typeof userMessage === 'string' ? userMessage.trim() : '';
    if (!text) {
      throw new BadRequestError('message must be non-empty');
    }
    if (typeof conversationId !== 'string' || !conversationId.trim()) {
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
      // The first build may still be running: wait for it rather than failing the turn.
      if (this.contextService.isBuilding()) {
        this.log({
          category: 'chat',
          level: 'info',
          message:
            'Code context is still being built; this message will be answered when it is ready.',
        });
      }
      if (!(await this.contextService.waitUntilReady(CONTEXT_WAIT_MS))) {
        throw new BadRequestError(
          'Code context is not ready yet. Wait for “Code context ready” in the logs, then send again.',
        );
      }
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
    const before = parseSummary(conversation.summary);
    await this.storeSuiteCheck(bundle, ai.suite_check);

    let prdResult: ChatPrdResult | null = null;
    let prdId = before.prd_id;
    if (ai.prd && ai.prd.requirements.length > 0) {
      const prd = await this.supabaseSuites.insertPrd(
        bundle.supabase.database,
        {
          workspacePath,
          conversationId,
          title: ai.prd.title,
          content: ai.prd.content || text,
          verdict: ai.prd.verdict,
          requirements: ai.prd.requirements.map((item) => ({
            id: item.id,
            text: item.text,
            status: item.status,
            evidence: item.evidence ?? '',
            gap: item.gap ?? '',
          })),
        },
      );
      prdId = prd.id;
      this.log({
        category: 'prd',
        level: 'success',
        message: `Saved PRD “${prd.title}” with ${prd.requirements.length} requirements (${prd.verdict === 'aligned' ? 'no gaps' : 'gaps found'}). Later suites in this conversation link to it.`,
        meta: { prdId: prd.id, verdict: prd.verdict },
      });
      prdResult = {
        id: prd.id,
        title: prd.title,
        verdict: prd.verdict,
        requirements: prd.requirements.map((item) => ({
          id: item.id,
          text: item.text,
          status: item.status,
          gap: item.gap,
        })),
      };
    }

    let detail: SuiteDetail | null = null;
    let reused = false;
    if (ai.intent === INTENT_SUITE_REUSED && ai.reuse_suite_id) {
      detail = await this.suites.getDetail(
        bundle.supabase.database,
        ai.reuse_suite_id,
        { withRuns: false },
      );
      if (detail && detail.suite.workspacePath !== workspacePath) {
        detail = null;
      }
      reused = detail !== null;
      if (detail) {
        this.log({
          category: 'suite',
          level: 'success',
          message: `Reusing ${detail.module.name || detail.module.moduleKey} v${detail.suite.version} as it is (${detail.cases.length} cases).`,
          meta: { suiteId: detail.suite.id },
        });
        // A PRD checked in this conversation also applies to the suite reused for it.
        if (
          prdId &&
          !detail.suite.prdId &&
          (await this.supabaseSuites.linkPrd(
            bundle.supabase.database,
            detail.suite.id,
            prdId,
          ))
        ) {
          detail = {
            ...detail,
            suite: { ...detail.suite, prdId },
          };
          this.log({
            category: 'prd',
            level: 'info',
            message: `Linked the conversation's PRD to ${detail.module.name || detail.module.moduleKey} v${detail.suite.version}; its report will include the traceability matrix.`,
            meta: { suiteId: detail.suite.id, prdId },
          });
        }
      }
    } else {
      const generated =
        asGeneratedSuite(ai.test_suite) ?? suiteFromLegacySteps(ai.cdp_steps);
      if (generated) {
        detail = await this.suites.createVersion(bundle.supabase, {
          workspacePath,
          conversationId,
          moduleKey: generated.moduleKey,
          moduleName: generated.moduleName,
          feature: generated.feature,
          prdId: prdId || null,
          cases: generated.cases,
        });
        // Written from today's code, so it is valid for today's code: later checks
        // with the same fingerprint reuse this verdict instead of re-reviewing.
        if (ai.suite_fingerprint) {
          await this.storeSuiteCheck(bundle, {
            suite_id: detail.suite.id,
            fingerprint: ai.suite_fingerprint,
            valid: true,
            stale_cases: [],
            uncovered: [],
            summary: 'Valid when created.',
            baseline: true,
            checked_at: new Date().toISOString(),
          });
        }
      }
    }

    const latest = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    const stored = parseSummary(latest?.summary ?? conversation.summary);
    const newPlans = detail ? plansFrom(detail, ai.responseId) : [];
    const summary: ConversationSummary = {
      case: ai.case ?? stored.case,
      brief_summary: ai.brief_summary || stored.brief_summary,
      plans: [
        ...stored.plans.filter(
          (plan) => !newPlans.some((item) => item.id === plan.id),
        ),
        ...newPlans,
      ],
      cdp_runs: stored.cdp_runs,
      // A question about run results is an aside: the flow it interrupts stays current.
      intent:
        ai.intent && ai.intent !== INTENT_SUITE_STATUS
          ? ai.intent
          : stored.intent,
      focus_paths:
        ai.focus_paths && ai.focus_paths.length > 0
          ? ai.focus_paths
          : stored.focus_paths,
      active_suite_id: detail?.suite.id ?? stored.active_suite_id,
      pending_action: asPendingAction(ai.pending_action),
      pending_suite_id: ai.pending_action ? (ai.pending_suite_id ?? '') : '',
      prd_id: prdId,
    };
    await this.supabaseChat.updateSummary(
      bundle.supabase.database,
      conversationId,
      JSON.stringify(summary),
    );

    const chatSuite = detail ? chatSuiteFrom(detail, reused) : null;
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
          ...(chatSuite
            ? {
                feature: chatSuite.feature,
                suite_id: chatSuite.suiteId,
                version: chatSuite.version,
                module_key: chatSuite.moduleKey,
                module_name: chatSuite.moduleName,
                reused: chatSuite.reused,
                cases: chatSuite.cases,
              }
            : {}),
          ...(prdResult ? { prd: prdResult } : {}),
        },
      },
    );

    this.log({
      category: 'chat',
      level: 'info',
      message: `Turn finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${ai.intent || 'reply'}).`,
      durationMs: Date.now() - startedAt,
      meta: { intent: ai.intent ?? '' },
    });
    return {
      conversationId,
      responseId: saved.id,
      reply: ai.reply,
      suite: chatSuite,
      summary,
      prd: prdResult,
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

  /**
   * Run test cases: one case, a chosen group, or a whole suite (suiteId).
   * Cases run one after another; `cdpStepsId` is the older single-plan form.
   */
  async runCases(input: {
    conversationId: string;
    caseIds?: string[];
    suiteId?: string;
    cdpStepsId?: string;
  }): Promise<{ ok: true; caseIds: string[]; suiteId: string | null }> {
    const conversationId = input.conversationId?.trim();
    if (!conversationId) {
      throw new BadRequestError('conversationId is required');
    }
    const workspacePath = this.resolveWorkspace();
    const bundle = this.loadWorkspaceBundle(workspacePath);
    const conversation = await this.supabaseChat.getConversation(
      bundle.supabase.database,
      conversationId,
    );
    if (!conversation || conversation.workspacePath !== workspacePath) {
      throw new NotFoundError(`Conversation ${conversationId} not found`);
    }
    if (this.runOrchestrator.isCdpRunning()) {
      throw new BadRequestError(
        'A test run is already in progress. Wait for it to finish.',
      );
    }

    const requested = [
      ...(input.caseIds ?? []),
      ...(input.cdpStepsId ? [input.cdpStepsId] : []),
    ]
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean);
    if (!input.suiteId && requested.length === 0) {
      throw new BadRequestError('Pass caseIds or suiteId to run.');
    }
    if (
      (input.suiteId && !isUuid(input.suiteId)) ||
      requested.some((id) => !isUuid(id))
    ) {
      throw new BadRequestError('caseIds and suiteId must be UUIDs.');
    }

    const database = bundle.supabase.database;
    const items: CaseRunItem[] = [];
    let suiteId: string | null = null;
    const stamp = runStamp();

    if (input.suiteId || requested.length > 0) {
      const cases = input.suiteId
        ? await this.supabaseSuites.listCases(database, [input.suiteId])
        : await this.supabaseSuites.getCases(database, requested);
      const wanted = input.suiteId
        ? cases
        : requested.flatMap((id) => cases.filter((item) => item.id === id));
      const suiteIds = [...new Set(wanted.map((item) => item.suiteId))];
      const details = new Map<string, SuiteDetail>();
      for (const id of suiteIds) {
        const detail = await this.suites.getDetail(database, id, {
          withRuns: false,
        });
        if (!detail || detail.suite.workspacePath !== workspacePath) {
          throw new NotFoundError(`Test suite ${id} not found`);
        }
        details.set(id, detail);
      }
      suiteId = suiteIds.length === 1 ? suiteIds[0] : null;
      for (const item of wanted) {
        const detail = details.get(item.suiteId)!;
        const position =
          detail.cases.findIndex((entry) => entry.id === item.id) + 1;
        items.push({
          caseId: item.id,
          suiteId: item.suiteId,
          steps: item.steps,
          runFolder: [
            stamp,
            moduleSlug(detail.module),
            `v${detail.suite.version}`,
            `${String(position).padStart(2, '0')}-${slugify(item.title, 32)}`,
          ].join('_'),
        });
      }
    }

    // Older conversations: ids that are not test cases may be cdp_plans rows.
    const missing = input.suiteId
      ? []
      : requested.filter((id) => !items.some((item) => item.caseId === id));
    for (const id of missing) {
      const plan = await this.supabaseChat.getCdpPlan(database, id);
      if (!plan || plan.workspacePath !== workspacePath) {
        throw new NotFoundError(
          `Test case ${id} not found. It may belong to a purged suite version.`,
        );
      }
      if (plan.conversationId !== conversationId) {
        throw new BadRequestError(
          'CDP plan belongs to a different conversation.',
        );
      }
      items.push({
        caseId: id,
        suiteId: null,
        steps: plan.steps,
        runFolder: `${stamp}_${slugify(plan.title || 'plan', 40)}`,
      });
    }

    const empty = items.find((item) => item.steps.length === 0);
    if (empty) {
      throw new BadRequestError(`Test case ${empty.caseId} has no steps`);
    }
    if (items.length === 0) {
      throw new BadRequestError('That suite has no test cases.');
    }

    this.log({
      category: 'cdp',
      level: 'info',
      message:
        items.length === 1
          ? `Queued 1 test case (${items[0].runFolder}).`
          : `Queued ${items.length} test cases to run one after another.`,
      meta: { suiteId, caseIds: items.map((item) => item.caseId) },
    });
    void this.runOrchestrator.runCases({ conversationId, suiteId, items });
    this.logger.log(`Started ${items.length} test case run(s)`);
    return { ok: true, caseIds: items.map((item) => item.caseId), suiteId };
  }

  /** RunRecorder: a test_runs row is opened when the browser starts. */
  async start(
    context: RunContext & { runFolder: string },
  ): Promise<string | null> {
    if (!context.suiteId || !context.caseId) {
      return null;
    }
    const bundle = this.activeBundle();
    const run = await this.supabaseSuites.insertRun(bundle.supabase.database, {
      caseId: context.caseId,
      suiteId: context.suiteId,
      batchId: context.batchId,
      conversationId: context.conversationId,
      runFolder: context.runFolder,
    });
    return run.id;
  }

  /** RunRecorder: close the run row and add the result to the conversation. */
  async finish(context: RunContext, outcome: RunOutcome): Promise<void> {
    const bundle = this.activeBundle();
    if (outcome.testRunId) {
      await this.supabaseSuites.finishRun(
        bundle.supabase.database,
        outcome.testRunId,
        {
          status: outcome.status,
          statusMessage: outcome.statusMessage,
          failedStep: outcome.failedStep,
          screenshots: outcome.screenshots,
        },
      );
    }
    if (context.conversationId && context.caseId) {
      await this.recordCdpRun(
        context.conversationId,
        context.caseId,
        outcome.status,
        outcome.statusMessage,
        outcome.screenshots,
      );
    }
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
      suite_id: plan?.suite_id ?? '',
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
    if (!conversation || conversation.workspacePath !== workspacePath) {
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
