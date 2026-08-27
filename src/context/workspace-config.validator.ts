import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WorkspaceAiConfig,
  WorkspaceSupabaseBucketConfig,
  WorkspaceSupabaseConfig,
  WorkspaceSupabaseDatabaseConfig,
} from './workspace-config.types';

export type WorkspaceConfigValidation =
  | {
      ok: true;
      excluded: string[];
      configPath: string;
      supabase: WorkspaceSupabaseConfig;
      ai: WorkspaceAiConfig | null;
    }
  | { ok: false; error: string };

function readNonEmptyString(
  value: unknown,
  fieldLabel: string,
): string | { error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return {
      error: `"${fieldLabel}" must be a non-empty string in .tursor/config.json`,
    };
  }
  return value.trim();
}

function parseSupabaseSection(
  supabaseRaw: Record<string, unknown>,
):
  | { ok: true; supabase: WorkspaceSupabaseConfig }
  | { ok: false; error: string } {
  const bucketRaw = supabaseRaw.bucket;
  const databaseRaw = supabaseRaw.database;

  if (
    bucketRaw &&
    typeof bucketRaw === 'object' &&
    databaseRaw &&
    typeof databaseRaw === 'object'
  ) {
    const bucketObj = bucketRaw as Record<string, unknown>;
    const databaseObj = databaseRaw as Record<string, unknown>;

    const bucketUrl = readNonEmptyString(
      bucketObj.url ?? supabaseRaw.url ?? supabaseRaw.SUPABASE_URL,
      'supabase.bucket.url',
    );
    if (typeof bucketUrl === 'object') {
      return { ok: false, error: bucketUrl.error };
    }

    const bucketKey = readNonEmptyString(
      bucketObj.serviceRoleKey ??
        supabaseRaw.serviceRoleKey ??
        supabaseRaw.SUPABASE_SERVICE_ROLE_KEY,
      'supabase.bucket.serviceRoleKey',
    );
    if (typeof bucketKey === 'object') {
      return { ok: false, error: bucketKey.error };
    }

    const bucketName = readNonEmptyString(
      bucketObj.name ??
        bucketObj.storageBucket ??
        supabaseRaw.storageBucket ??
        supabaseRaw.SUPABASE_STORAGE_BUCKET,
      'supabase.bucket.name',
    );
    if (typeof bucketName === 'object') {
      return { ok: false, error: bucketName.error };
    }

    const databaseUrl = readNonEmptyString(
      databaseObj.url ?? supabaseRaw.url ?? supabaseRaw.SUPABASE_URL,
      'supabase.database.url',
    );
    if (typeof databaseUrl === 'object') {
      return { ok: false, error: databaseUrl.error };
    }

    const databaseKey = readNonEmptyString(
      databaseObj.serviceRoleKey ??
        supabaseRaw.serviceRoleKey ??
        supabaseRaw.SUPABASE_SERVICE_ROLE_KEY,
      'supabase.database.serviceRoleKey',
    );
    if (typeof databaseKey === 'object') {
      return { ok: false, error: databaseKey.error };
    }

    const schemaRaw = databaseObj.schema;
    const schema =
      typeof schemaRaw === 'string' && schemaRaw.trim()
        ? schemaRaw.trim()
        : 'public';

    const bucket: WorkspaceSupabaseBucketConfig = {
      url: bucketUrl,
      serviceRoleKey: bucketKey,
      name: bucketName,
    };
    const database: WorkspaceSupabaseDatabaseConfig = {
      url: databaseUrl,
      serviceRoleKey: databaseKey,
      schema,
    };

    return { ok: true, supabase: { bucket, database } };
  }

  const legacyUrl = readNonEmptyString(
    supabaseRaw.url ?? supabaseRaw.SUPABASE_URL,
    'supabase.url',
  );
  if (typeof legacyUrl === 'object') {
    return { ok: false, error: legacyUrl.error };
  }

  const legacyKey = readNonEmptyString(
    supabaseRaw.serviceRoleKey ?? supabaseRaw.SUPABASE_SERVICE_ROLE_KEY,
    'supabase.serviceRoleKey',
  );
  if (typeof legacyKey === 'object') {
    return { ok: false, error: legacyKey.error };
  }

  const legacyBucket = readNonEmptyString(
    supabaseRaw.storageBucket ?? supabaseRaw.SUPABASE_STORAGE_BUCKET,
    'supabase.storageBucket',
  );
  if (typeof legacyBucket === 'object') {
    return {
      ok: false,
      error:
        'Missing "supabase.bucket" and "supabase.database" objects. ' +
        'Use nested config or legacy flat keys (url, serviceRoleKey, storageBucket).',
    };
  }

  const bucket: WorkspaceSupabaseBucketConfig = {
    url: legacyUrl,
    serviceRoleKey: legacyKey,
    name: legacyBucket,
  };
  const database: WorkspaceSupabaseDatabaseConfig = {
    url: legacyUrl,
    serviceRoleKey: legacyKey,
    schema: 'public',
  };

  return { ok: true, supabase: { bucket, database } };
}

@Injectable()
export class WorkspaceConfigValidator {
  validate(workspacePath: string): WorkspaceConfigValidation {
    const root = path.resolve(workspacePath);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ok: false, error: `Not a directory: ${root}` };
    }

    const configPath = path.join(root, '.tursor', 'config.json');
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      return {
        ok: false,
        error: `Missing .tursor/config.json under ${root}`,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    } catch {
      return { ok: false, error: `Invalid JSON in ${configPath}` };
    }

    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `${configPath} must be a JSON object` };
    }

    const config = raw as Record<string, unknown>;

    const excludedRaw = config.excluded;
    if (excludedRaw === undefined) {
      /* optional */
    } else if (!Array.isArray(excludedRaw)) {
      return { ok: false, error: '"excluded" must be an array' };
    } else {
      for (const item of excludedRaw) {
        if (typeof item !== 'string' || !item.trim()) {
          return {
            ok: false,
            error: '"excluded" entries must be non-empty strings',
          };
        }
      }
    }

    const excluded = Array.isArray(excludedRaw)
      ? excludedRaw.map((item) => item.trim())
      : [];

    const supabaseRaw = config.supabase;
    if (!supabaseRaw || typeof supabaseRaw !== 'object') {
      return {
        ok: false,
        error:
          'Missing required "supabase" object in .tursor/config.json ' +
          '(bucket + database nested objects)',
      };
    }

    const supabaseParsed = parseSupabaseSection(
      supabaseRaw as Record<string, unknown>,
    );
    if (!supabaseParsed.ok) {
      return { ok: false, error: supabaseParsed.error };
    }

    let ai: WorkspaceAiConfig | null = null;
    const aiRaw = config.ai;
    if (aiRaw !== undefined) {
      if (!aiRaw || typeof aiRaw !== 'object') {
        return { ok: false, error: '"ai" must be an object' };
      }
      const aiObj = aiRaw as Record<string, unknown>;
      const generationModel = readNonEmptyString(
        aiObj.generationModel,
        'ai.generationModel',
      );
      if (typeof generationModel === 'object') {
        return { ok: false, error: generationModel.error };
      }
      const apiKey = readNonEmptyString(aiObj.apiKey, 'ai.apiKey');
      if (typeof apiKey === 'object') {
        return { ok: false, error: apiKey.error };
      }
      ai = { generationModel, apiKey };
    }

    return {
      ok: true,
      excluded,
      configPath,
      supabase: supabaseParsed.supabase,
      ai,
    };
  }
}
