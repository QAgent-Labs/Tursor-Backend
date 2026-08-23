import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WorkspaceAiConfig,
  WorkspaceSupabaseConfig,
  WorkspaceTursorConfig,
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

    const config = raw as Partial<WorkspaceTursorConfig> & {
      supabase?: Record<string, unknown>;
    };

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
          'Missing required "supabase" object in .tursor/config.json (url, serviceRoleKey, storageBucket)',
      };
    }

    const url = readNonEmptyString(
      supabaseRaw.url ?? supabaseRaw.SUPABASE_URL,
      'supabase.url',
    );
    if (typeof url === 'object') return { ok: false, error: url.error };

    const serviceRoleKey = readNonEmptyString(
      supabaseRaw.serviceRoleKey ?? supabaseRaw.SUPABASE_SERVICE_ROLE_KEY,
      'supabase.serviceRoleKey',
    );
    if (typeof serviceRoleKey === 'object') {
      return { ok: false, error: serviceRoleKey.error };
    }

    const storageBucket = readNonEmptyString(
      supabaseRaw.storageBucket ?? supabaseRaw.SUPABASE_STORAGE_BUCKET,
      'supabase.storageBucket',
    );
    if (typeof storageBucket === 'object') {
      return { ok: false, error: storageBucket.error };
    }

    let ai: WorkspaceAiConfig | null = null;
    const aiRaw = config.ai;
    if (aiRaw !== undefined) {
      if (!aiRaw || typeof aiRaw !== 'object') {
        return { ok: false, error: '"ai" must be an object' };
      }
      const generationModel = readNonEmptyString(
        aiRaw.generationModel,
        'ai.generationModel',
      );
      if (typeof generationModel === 'object') {
        return { ok: false, error: generationModel.error };
      }
      const apiKey = readNonEmptyString(aiRaw.apiKey, 'ai.apiKey');
      if (typeof apiKey === 'object') {
        return { ok: false, error: apiKey.error };
      }
      ai = { generationModel, apiKey };
    }

    return {
      ok: true,
      excluded,
      configPath,
      supabase: { url, serviceRoleKey, storageBucket },
      ai,
    };
  }
}
