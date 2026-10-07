import type { CdpStepDefinition } from '../cdp/cdp-step.types';
import { createLogger } from '../lib/logger';
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
    feature: string;
    cases: Array<{
      id: string;
      kind: string;
      title: string;
      steps: CdpStepDefinition[];
    }>;
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
    cases: TursorAiSuiteCase[];
  } | null;
  cdp_steps?: CdpStepDefinition[] | null;
  retrieved_chunk_count?: number;
};

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
      const res = await fetch(url.toString());
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
      headers: { 'Content-Type': 'application/json' },
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

  async ragSearch(
    directoryPath: string,
    query: string,
    topK = 8,
  ): Promise<TursorAiRagChunk[]> {
    const url = `${this.baseUrl()}/v1/rag/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
