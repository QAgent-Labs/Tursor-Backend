import type { CdpStepDefinition } from '../cdp/cdp-step.types';
import { config } from '../lib/config';
import { createLogger } from '../lib/logger';
import { currentTrace } from '../lib/trace';
import { TursorAiRuntimeService } from './tursor-ai-runtime.service';

export type TursorAiEmbedResult = {
  directory_path: string;
  embeddings_dir: string;
  files_indexed: number;
  chunks_indexed: number;
  model: string;
  files_added?: number;
  files_updated?: number;
  files_removed?: number;
  files_unchanged?: number;
  incremental?: boolean;
  flow_map_needed?: boolean;
};

export type TursorAiFlowMapResult = {
  screens: number;
  reachable: number;
  described: number;
  failedBatches: number;
  skipped: boolean;
};

export type TursorAiRagChunk = {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  score: number;
};

export type TursorAiSuiteCase = {
  kind: 'success' | 'failure' | 'edge';
  title: string;
  explanation?: string;
  steps: CdpStepDefinition[];
  requirement_ids?: string[];
};

export type TursorAiPrdRequirement = {
  id: string;
  text: string;
  status: 'implemented' | 'partial' | 'missing';
  evidence?: string;
  gap?: string;
};

export type TursorAiReportRequest = {
  format: 'md' | 'pdf';
  /** Lets Tursor-AI read the flow map to explain the feature. */
  workspace_path: string;
  generation_model: string;
  api_key: string;
  suite: {
    suite_id: string;
    module_key: string;
    module_name: string;
    feature: string;
    version: number;
    created_at: string;
    cases: Array<{
      case_id: string;
      kind: string;
      title: string;
      explanation: string;
      requirement_ids: string[];
      steps: CdpStepDefinition[];
      runs: Array<{
        run_id: string;
        status: 'passed' | 'failure';
        status_message: string;
        failed_step: string;
        run_folder: string;
        screenshots: string[];
        started_at: string;
        finished_at: string;
      }>;
    }>;
  };
  prd: {
    title: string;
    verdict: 'aligned' | 'gaps';
    requirements: Array<{
      id: string;
      text: string;
      status: string;
      gap: string;
    }>;
  } | null;
};

export type TursorAiReportResult = {
  format: 'md' | 'pdf';
  filename: string;
  content_type: string;
  encoding: 'utf-8' | 'base64';
  content: string;
  metrics: {
    total: number;
    executed: number;
    passed: number;
    failed: number;
    not_run: number;
    runs: number;
  };
};

export type TursorAiChatRequest = {
  conversation_id: string;
  workspace_path: string;
  message: string;
  generation_model: string;
  api_key: string;
  mode?: 'chat' | 'intro';
  case?: string;
  brief_summary?: string;
  plans?: Array<{
    id: string;
    title: string;
    response_id?: string;
    feature?: string;
    kind?: string;
  }>;
  cdp_runs?: Array<{
    cdp_step_id: string;
    status: 'passed' | 'failure';
    status_message: string;
    response_id?: string;
    feature?: string;
    case_id?: string;
    title?: string;
    kind?: string;
  }>;
  latest_cdp_steps?: CdpStepDefinition[] | null;
  latest_test_suite?: {
    response_id: string;
    suite_id?: string;
    module_key?: string;
    version?: number;
    feature: string;
    cases: Array<{
      id: string;
      kind: string;
      title: string;
      steps: CdpStepDefinition[];
      requirement_ids?: string[];
    }>;
  } | null;
  intent?: string;
  focus_paths?: string[];
  existing_suites?: Array<{
    suite_id: string;
    module_key: string;
    module_name: string;
    feature: string;
    version: number;
    created_at: string;
    cases: Array<{
      id: string;
      title: string;
      kind: string;
      last_status: string;
      last_run: {
        run_id: string;
        status: string;
        finished_at: string;
        failed_step: string;
        status_message: string;
      } | null;
      steps: CdpStepDefinition[];
    }>;
    checked_fingerprint: string;
    check_result: Record<string, unknown> | null;
  }>;
  pending_action?: string;
  pending_suite_id?: string;
  active_suite_id?: string;
  prd?: {
    prd_id: string;
    title: string;
    requirements: Array<{ id: string; text: string; status: string }>;
  } | null;
};

export type TursorAiChatResult = {
  conversation_id?: string;
  response_id?: string;
  reply: string;
  case?: string;
  brief_summary?: string;
  test_suite?: {
    feature: string;
    module_key?: string;
    module_name?: string;
    cases: TursorAiSuiteCase[];
  } | null;
  cdp_steps?: CdpStepDefinition[] | null;
  retrieved_chunk_count?: number;
  intent?: string;
  focus_paths?: string[];
  reuse_suite_id?: string;
  pending_action?: string;
  pending_suite_id?: string;
  /** Fingerprint of the files behind a newly generated suite (valid when created). */
  suite_fingerprint?: string;
  /** Verdict of checking a saved suite against the code, to store on that suite. */
  suite_check?:
    | (Record<string, unknown> & {
        suite_id?: string;
        fingerprint?: string;
        reused?: boolean;
      })
    | null;
  prd?: {
    title: string;
    verdict: 'aligned' | 'gaps';
    content: string;
    requirements: TursorAiPrdRequirement[];
  } | null;
};

/** Headers that let Tursor-AI send its logs for this request back to the panel. */
function traceHeaders(): Record<string, string> {
  const trace = currentTrace();
  if (!trace) return {};
  return {
    'X-Tursor-Trace': trace.traceId,
    'X-Tursor-Log-Sink': `http://127.0.0.1:${config.port}/logs/ingest`,
  };
}

export class TursorAiClient {
  private readonly logger = createLogger('TursorAiClient');

  constructor(private readonly runtime: TursorAiRuntimeService) {}

  async ensureReady(): Promise<void> {
    await this.runtime.refresh();
  }

  private baseUrl(): string {
    return this.runtime.resolveBaseUrl();
  }

  async validate(
    directoryPath: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = new URL('/v1/validate', this.baseUrl());
    url.searchParams.set('directory_path', directoryPath);

    try {
      const res = await fetch(url.toString(), { headers: traceHeaders() });
      if (!res.ok) {
        return { ok: false, error: `Tursor-AI validate HTTP ${res.status}` };
      }
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (body.ok === true) {
        return { ok: true };
      }
      return {
        ok: false,
        error: body.error ?? 'Tursor-AI validation failed',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tursor-AI unreachable: ${msg}`);
      return {
        ok: false,
        error: `Tursor-AI not reachable at ${this.baseUrl()} (${msg})`,
      };
    }
  }

  async embed(directoryPath: string): Promise<TursorAiEmbedResult> {
    const url = `${this.baseUrl()}/v1/embed`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify({ directory_path: directoryPath }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Tursor-AI embed failed HTTP ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    return (await res.json()) as TursorAiEmbedResult;
  }

  async buildFlowMap(directoryPath: string): Promise<TursorAiFlowMapResult> {
    const url = `${this.baseUrl()}/v1/flow-map`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify({ directory_path: directoryPath }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Tursor-AI flow map failed HTTP ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    const body = (await res.json()) as {
      screens?: number;
      reachable?: number;
      described?: number;
      failed_batches?: number;
      skipped?: boolean;
    };
    return {
      screens: body.screens ?? 0,
      reachable: body.reachable ?? 0,
      described: body.described ?? 0,
      failedBatches: body.failed_batches ?? 0,
      skipped: body.skipped === true,
    };
  }

  async generateReport(
    payload: TursorAiReportRequest,
  ): Promise<TursorAiReportResult> {
    const url = `${this.baseUrl()}/v1/report`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Tursor-AI report failed HTTP ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    return (await res.json()) as TursorAiReportResult;
  }

  async ragSearch(
    directoryPath: string,
    query: string,
    topK = 8,
  ): Promise<TursorAiRagChunk[]> {
    const url = `${this.baseUrl()}/v1/rag/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify({
        directory_path: directoryPath,
        query,
        top_k: topK,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Tursor-AI rag/search failed HTTP ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    const body = (await res.json()) as { chunks?: TursorAiRagChunk[] };
    return body.chunks ?? [];
  }

  async chatCompletion(
    payload: TursorAiChatRequest,
  ): Promise<TursorAiChatResult> {
    const url = `${this.baseUrl()}/v1/chat/completion`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...traceHeaders() },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Tursor-AI chat/completion failed HTTP ${res.status}: ${detail.slice(0, 500)}`,
      );
    }

    return (await res.json()) as TursorAiChatResult;
  }
}
