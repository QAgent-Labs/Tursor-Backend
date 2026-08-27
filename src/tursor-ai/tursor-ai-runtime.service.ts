import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const execFileAsync = promisify(execFile);

type PortJson = {
  running?: boolean;
  port?: number | null;
  origin?: string | null;
};

@Injectable()
export class TursorAiRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(TursorAiRuntimeService.name);
  private resolvedOrigin: string | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Resolved base URL (no trailing slash), or null if Tursor-AI is not up. */
  getResolvedOrigin(): string | null {
    return this.resolvedOrigin;
  }

  resolveBaseUrl(): string {
    const fromRuntime = this.resolvedOrigin;
    if (fromRuntime) {
      return fromRuntime;
    }
    const raw =
      this.configService.get<string>('TURSOR_AI_URL') ??
      'http://127.0.0.1:8000';
    return raw.replace(/\/$/, '');
  }

  isReachable(): boolean {
    return this.resolvedOrigin !== null;
  }

  async refresh(): Promise<boolean> {
    const fromCli = await this.probeViaCli();
    if (fromCli) {
      this.resolvedOrigin = fromCli;
      this.logger.log(`Tursor-AI origin ${fromCli} (via tursorAI CLI)`);
      return true;
    }

    const fromFile = this.readRuntimeFile();
    if (fromFile) {
      const ok = await this.probeOrigin(fromFile);
      if (ok) {
        this.resolvedOrigin = fromFile;
        this.logger.log(`Tursor-AI origin ${fromFile} (runtime.json)`);
        return true;
      }
    }

    const fallback = this.resolveBaseUrl();
    const fallbackOk = await this.probeOrigin(fallback);
    if (fallbackOk) {
      this.resolvedOrigin = fallback;
      this.logger.log(`Tursor-AI origin ${fallback} (env / default)`);
      return true;
    }

    this.resolvedOrigin = null;
    this.logger.warn(
      'Tursor-AI is not reachable (run `tursorAI start` or set TURSOR_AI_URL)',
    );
    return false;
  }

  /** Best-effort start via local `tursorAI` CLI, then poll /health. */
  async tryStartViaCli(): Promise<boolean> {
    const cli = this.tursorAiCliPath();
    try {
      await execFileAsync(cli, ['start'], {
        env: this.cliEnv(),
        timeout: 120_000,
        maxBuffer: 8192,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`tursorAI start failed: ${msg}`);
    }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await this.refresh()) {
        return true;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }

    return false;
  }

  private tursorAiCliPath(): string {
    const home = os.homedir();
    const name = process.platform === 'win32' ? 'tursorAI.cmd' : 'tursorAI';
    const candidates = [
      path.join(home, '.tursor-ai', 'npm-global', 'bin', name),
      path.join(home, '.tursor-ai', 'npm-global', 'bin', 'tursorAI'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return 'tursorAI';
  }

  private cliEnv(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const prefix = path.join(home, '.tursor-ai', 'npm-global', 'bin');
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const existing = process.env[pathKey] ?? '';
    return {
      ...process.env,
      [pathKey]: `${prefix}${path.delimiter}${existing}`,
    };
  }

  private async probeViaCli(): Promise<string | null> {
    const cli = this.tursorAiCliPath();
    try {
      const { stdout } = await execFileAsync(cli, ['port', '--json'], {
        env: this.cliEnv(),
        timeout: 8_000,
        maxBuffer: 4096,
      });
      const data = JSON.parse(stdout.trim()) as PortJson;
      if (data.running && data.origin) {
        return data.origin.replace(/\/$/, '');
      }
      if (data.running && typeof data.port === 'number' && data.port > 0) {
        return `http://127.0.0.1:${data.port}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`tursorAI port --json failed: ${msg}`);
    }
    return null;
  }

  private runtimeFilePath(): string {
    return path.join(os.homedir(), '.tursor-ai', 'runtime.json');
  }

  private readRuntimeFile(): string | null {
    try {
      const raw = fs.readFileSync(this.runtimeFilePath(), 'utf8');
      const data = JSON.parse(raw) as { origin?: string; port?: number };
      if (typeof data.origin === 'string' && data.origin.length > 0) {
        return data.origin.replace(/\/$/, '');
      }
      if (typeof data.port === 'number' && data.port > 0) {
        return `http://127.0.0.1:${data.port}`;
      }
    } catch {
      /* missing */
    }
    return null;
  }

  private async probeOrigin(origin: string): Promise<boolean> {
    try {
      const url = `${origin.replace(/\/$/, '')}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
