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

export type TursorAiChatRequest = {
  workspace_path: string;
  message: string;
  generation_model: string;
  api_key: string;
  mode?: 'chat' | 'intro' | 'generate_test';
  conversation_state?: string;
  conversation_summary?: string | null;
  recent_messages?: Array<{ role: string; content: string }>;
  approved_test_flow?: Array<{ step: number; action: string }> | null;
  rag_query?: string | null;
  rag_top_k?: number;
};

export type TursorAiChatResult = {
  ok: boolean;
  type: string;
  content?: string;
  status?: string;
  testFlow?: Array<{ step: number; action: string }>;
  language?: string;
  framework?: string;
  testName?: string;
  code?: string;
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
