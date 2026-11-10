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
    await this.uploadWithRetry(
      client,
      bucket,
      objectPath,
      body,
      'image/jpeg',
      'Screenshot',
    );

    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    const publicUrl = data.publicUrl;
    if (!publicUrl) {
      throw new Error('Supabase public URL missing (is the bucket public?)');
    }

    this.logger.debug(`Uploaded screenshot ${objectPath} → ${publicUrl}`);
    return publicUrl;
  }

  /**
   * Upload a generated report and return its public URL.
   * DEVELOPMENT ONLY - NOT SECURE FOR PRODUCTION: the bucket is public, so anyone
   * with the URL can read the report. Move reports to a private bucket with
   * signed URLs before production use.
   */
  async uploadReport(
    bucketConfig: WorkspaceSupabaseBucketConfig,
    objectPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    if (!this.isConfigured(bucketConfig)) {
      throw new Error(this.missingConfigMessage());
    }
    const bucket = bucketConfig.name.trim();
    const client = this.getClient(bucketConfig);
    await this.uploadWithRetry(
      client,
      bucket,
      objectPath,
      body,
      contentType,
      'Report',
    );
    return client.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
  }

  /** Upload with backoff; connect timeouts to Supabase are usually transient. */
  private async uploadWithRetry(
    client: SupabaseClient,
    bucket: string,
    objectPath: string,
    body: Buffer,
    contentType: string,
    label: string,
  ): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { error } = await client.storage
        .from(bucket)
        .upload(objectPath, body, { contentType, upsert: true });
      if (!error) {
        return;
      }

      const detail = formatStorageError(error);
      this.logger.warn(
        `${label} upload attempt ${attempt}/${maxAttempts} failed (${objectPath}, ${body.length} bytes): ${detail}`,
      );
      if (attempt === maxAttempts) {
        throw new Error(
          `Supabase ${label.toLowerCase()} upload failed after ${maxAttempts} attempts: ${detail}`,
        );
      }
      await sleep(1000 * attempt);
    }
  }

  /** Delete every screenshot under runs/{folder}/ for each run folder. */
  async removeRunFolders(
    bucketConfig: WorkspaceSupabaseBucketConfig,
    runFolders: string[],
  ): Promise<void> {
    if (!this.isConfigured(bucketConfig) || runFolders.length === 0) {
      return;
    }
    const bucket = bucketConfig.name.trim();
    const client = this.getClient(bucketConfig);
    const paths: string[] = [];
    for (const folder of runFolders) {
      const safe = folder.replace(/[^a-zA-Z0-9-_]/g, '');
      if (!safe) continue;
      const { data, error } = await client.storage
        .from(bucket)
        .list(`runs/${safe}`, { limit: 1000 });
      if (error) {
        this.logger.warn(`Could not list runs/${safe}: ${error.message}`);
        continue;
      }
      for (const item of data ?? []) {
        paths.push(`runs/${safe}/${item.name}`);
      }
    }
    await this.removeObjects(bucketConfig, paths);
  }

  async removeObjects(
    bucketConfig: WorkspaceSupabaseBucketConfig,
    paths: string[],
  ): Promise<void> {
    if (!this.isConfigured(bucketConfig) || paths.length === 0) {
      return;
    }
    const client = this.getClient(bucketConfig);
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await client.storage
        .from(bucketConfig.name.trim())
        .remove(paths.slice(i, i + 100));
      if (error) {
        this.logger.warn(`Could not remove storage objects: ${error.message}`);
      }
    }
  }
}
