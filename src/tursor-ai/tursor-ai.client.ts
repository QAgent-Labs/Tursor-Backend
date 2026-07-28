import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type TursorAiEmbedResult = {
  directory_path: string;
  embeddings_dir: string;
  files_indexed: number;
  chunks_indexed: number;
  model: string;
};

@Injectable()
export class TursorAiClient {
  private readonly logger = new Logger(TursorAiClient.name);

  constructor(private readonly configService: ConfigService) {}

  private baseUrl(): string {
    const raw =
      this.configService.get<string>('TURSOR_AI_URL') ??
      'http://127.0.0.1:8000';
    return raw.replace(/\/$/, '');
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
}
