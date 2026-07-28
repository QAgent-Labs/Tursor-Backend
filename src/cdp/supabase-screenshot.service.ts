import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseScreenshotService {
  private readonly logger = new Logger(SupabaseScreenshotService.name);
  private client: SupabaseClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.url() && this.serviceRoleKey() && this.bucket());
  }

  private url(): string | undefined {
    const raw = this.configService.get<string>('SUPABASE_URL')?.trim();
    return raw || undefined;
  }

  private serviceRoleKey(): string | undefined {
    const raw = this.configService
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();
    return raw || undefined;
  }

  private bucket(): string | undefined {
    const raw = this.configService
      .get<string>('SUPABASE_STORAGE_BUCKET')
      ?.trim();
    return raw || undefined;
  }

  private getClient(): SupabaseClient {
    if (this.client) {
      return this.client;
    }
    const url = this.url();
    const key = this.serviceRoleKey();
    if (!url || !key) {
      throw new Error('Supabase is not configured');
    }
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  /**
   * Upload PNG to public bucket; returns public object URL.
   */
  async uploadPng(
    runId: string,
    stepId: string,
    buffer: Buffer,
  ): Promise<string> {
    const bucket = this.bucket();
    if (!bucket) {
      throw new Error('SUPABASE_STORAGE_BUCKET is not set');
    }

    const safeRun = runId.replace(/[^a-zA-Z0-9-_]/g, '');
    const safeStep = stepId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const objectPath = `runs/${safeRun}/${safeStep}.png`;

    const client = this.getClient();
    const { error } = await client.storage
      .from(bucket)
      .upload(objectPath, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    const publicUrl = data.publicUrl;
    if (!publicUrl) {
      throw new Error('Supabase public URL missing (is the bucket public?)');
    }

    this.logger.debug(`Uploaded screenshot ${objectPath}`);
    return publicUrl;
  }
}
