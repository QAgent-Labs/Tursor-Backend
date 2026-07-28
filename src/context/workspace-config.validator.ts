import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type WorkspaceConfigValidation =
  | { ok: true; excluded: string[]; configPath: string }
  | { ok: false; error: string };

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

    const excludedRaw = (raw as { excluded?: unknown }).excluded;
    if (excludedRaw === undefined) {
      return { ok: true, excluded: [], configPath };
    }
    if (!Array.isArray(excludedRaw)) {
      return { ok: false, error: '"excluded" must be an array' };
    }

    const excluded: string[] = [];
    for (const item of excludedRaw) {
      if (typeof item !== 'string' || !item.trim()) {
        return {
          ok: false,
          error: '"excluded" entries must be non-empty strings',
        };
      }
      excluded.push(item.trim());
    }

    return { ok: true, excluded, configPath };
  }
}
