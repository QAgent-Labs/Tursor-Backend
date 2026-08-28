import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../lib/logger';
import type { WorkspaceSupabaseBucketConfig } from '../context/workspace-config.types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatStorageError(error: {
  message: string;
  originalError?: unknown;
}): string {
  const parts = [error.message];
  const original = error.originalError;
  if (original instanceof Error) {
    parts.push(original.message);
    const cause = original.cause;
    if (cause instanceof Error && cause.message) {
      parts.push(cause.message);
    }
  }
  return parts.join(' — ');
}

export class SupabaseScreenshotService {
  private readonly logger = createLogger('SupabaseScreenshotService');
  private readonly clientCache = new Map<string, SupabaseClient>();

  isConfigured(config: WorkspaceSupabaseBucketConfig): boolean {
    return Boolean(
      config.url?.trim() &&
      config.serviceRoleKey?.trim() &&
      config.name?.trim(),
    );
  }

  missingConfigMessage(): string {
    return (
      'Supabase screenshot storage is not configured in .tursor/config.json. ' +
      'Add supabase.bucket with url, serviceRoleKey, and name.'
    );
  }

  private getClient(config: WorkspaceSupabaseBucketConfig): SupabaseClient {
    const url = config.url.trim();
    const key = config.serviceRoleKey.trim();
    const cacheKey = `${url}:${key.slice(0, 16)}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, {
            ...init,
            signal: init?.signal ?? AbortSignal.timeout(120_000),
          }),
      },
    });
    this.clientCache.set(cacheKey, client);
    return client;
  }

  /**
   * Upload screenshot JPEG to public bucket; returns public object URL.
   */
  async uploadPng(
    runId: string,
    stepId: string,
    buffer: Buffer,
    bucketConfig: WorkspaceSupabaseBucketConfig,
  ): Promise<string> {
    if (!this.isConfigured(bucketConfig)) {
      throw new Error(this.missingConfigMessage());
    }

    const bucket = bucketConfig.name.trim();
    const safeRun = runId.replace(/[^a-zA-Z0-9-_]/g, '');
    const safeStep = stepId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const objectPath = `runs/${safeRun}/${safeStep}.jpg`;

    const client = this.getClient(bucketConfig);
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const maxAttempts = 5;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { error } = await client.storage
        .from(bucket)
        .upload(objectPath, body, {
          contentType: 'image/jpeg',
          upsert: true,
        });

      if (!error) {
        lastError = undefined;
        break;
      }

      const detail = formatStorageError(error);
      lastError = new Error(`Supabase upload failed: ${detail}`);
      this.logger.warn(
        `Screenshot upload attempt ${attempt}/${maxAttempts} failed (${objectPath}, ${body.length} bytes): ${detail}`,
      );

      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    }

    if (lastError) {
      throw lastError;
    }

    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    const publicUrl = data.publicUrl;
    if (!publicUrl) {
      throw new Error('Supabase public URL missing (is the bucket public?)');
    }

    this.logger.debug(`Uploaded screenshot ${objectPath} → ${publicUrl}`);
    return publicUrl;
  }
}
