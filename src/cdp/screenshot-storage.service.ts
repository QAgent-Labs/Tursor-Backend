import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../lib/config';

export class ScreenshotStorageService {
  createRunDirectory(workspacePath: string | null): {
    runId: string;
    dir: string;
  } {
    const runId = `${Date.now()}`;
    const root = workspacePath
      ? path.join(workspacePath, '.tursor', 'run-screenshots', runId)
      : path.join(
          process.env.HOME ?? '/tmp',
          '.tursor',
          'run-screenshots',
          runId,
        );
    fs.mkdirSync(root, { recursive: true });
    return { runId, dir: root };
  }

  savePng(dir: string, stepId: string, buffer: Buffer): string {
    const safe = stepId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(dir, `${safe}.png`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  resolveFilePath(runId: string, filename: string): string | null {
    const safeRun = runId.replace(/[^a-zA-Z0-9-_]/g, '');
    const safeFile = path.basename(filename).replace(/[^a-zA-Z0-9-_.]/g, '');
    if (!safeRun || !safeFile.endsWith('.png')) {
      return null;
    }

    const candidates: string[] = [];
    const home = process.env.HOME ?? '';
    if (home) {
      candidates.push(
        path.join(home, '.tursor', 'run-screenshots', safeRun, safeFile),
      );
    }

    const cwd = process.cwd();
    candidates.push(
      path.join(cwd, '.tursor', 'run-screenshots', safeRun, safeFile),
    );

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return this.findUnderWorkspace(safeRun, safeFile);
  }

  private findUnderWorkspace(runId: string, filename: string): string | null {
    const searchRoots = [process.cwd(), process.env.HOME ?? ''].filter(Boolean);
    for (const root of searchRoots) {
      const base = path.join(root, '.tursor', 'run-screenshots', runId);
      const full = path.join(base, filename);
      if (fs.existsSync(full)) {
        return full;
      }
    }
    return null;
  }

  publicScreenshotUrl(runId: string, stepId: string): string {
    const safe = stepId.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `http://127.0.0.1:${config.port}/screenshots/${runId}/${safe}.png`;
  }

  registerRunLocation(runId: string, dir: string): void {
    const mapPath = path.join(dir, '..', '.index.json');
    const parent = path.dirname(mapPath);
    fs.mkdirSync(parent, { recursive: true });
    let index: Record<string, string> = {};
    if (fs.existsSync(mapPath)) {
      try {
        index = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as Record<
          string,
          string
        >;
      } catch {
        index = {};
      }
    }
    index[runId] = dir;
    fs.writeFileSync(mapPath, JSON.stringify(index, null, 2));
  }

  resolveFilePathWithIndex(runId: string, filename: string): string | null {
    const direct = this.resolveFilePath(runId, filename);
    if (direct) {
      return direct;
    }

    const safeRun = runId.replace(/[^a-zA-Z0-9-_]/g, '');
    const indexPaths = [
      path.join(process.cwd(), '.tursor', 'run-screenshots', '.index.json'),
    ];
    const home = process.env.HOME;
    if (home) {
      indexPaths.push(
        path.join(home, '.tursor', 'run-screenshots', '.index.json'),
      );
    }

    for (const indexPath of indexPaths) {
      if (!fs.existsSync(indexPath)) {
        continue;
      }
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as Record<
          string,
          string
        >;
        const dir = index[safeRun];
        if (dir) {
          const full = path.join(dir, path.basename(filename));
          if (fs.existsSync(full)) {
            return full;
          }
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}
