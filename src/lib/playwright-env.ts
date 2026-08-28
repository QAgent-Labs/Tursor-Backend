import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultBrowsersPath(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library/Caches/ms-playwright')]
      : process.platform === 'win32'
        ? [
            path.join(
              process.env.LOCALAPPDATA ?? os.homedir(),
              'ms-playwright',
            ),
          ]
        : [path.join(os.homedir(), '.cache/ms-playwright')];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Run before Playwright is imported anywhere. */
export function ensurePlaywrightBrowsersPath(): void {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (browsersPath?.includes('cursor-sandbox-cache')) {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  }

  const current = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (current && !current.includes('cursor-sandbox-cache')) {
    return;
  }

  const fallback = defaultBrowsersPath();
  if (fallback) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = fallback;
  }
}

ensurePlaywrightBrowsersPath();
