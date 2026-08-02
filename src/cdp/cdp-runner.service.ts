import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, type Page } from 'playwright';
import {
  type CdpRunCallbacks,
  type CdpAction,
  demoCdpSteps,
  describeAction,
} from './cdp-step.types';
import { ScreenshotStorageService } from './screenshot-storage.service';
import { SupabaseScreenshotService } from './supabase-screenshot.service';
import type { WorkspaceSupabaseConfig } from '../context/workspace-config.types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

@Injectable()
export class CdpRunnerService {
  private readonly logger = new Logger(CdpRunnerService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly screenshotStorage: ScreenshotStorageService,
    private readonly supabaseScreenshots: SupabaseScreenshotService,
  ) {}

  async runDemoFlow(
    frontendPort: number,
    workspacePath: string | null,
    supabase: WorkspaceSupabaseConfig,
    callbacks: CdpRunCallbacks,
  ): Promise<void> {
    const baseUrl = `http://127.0.0.1:${frontendPort}`;
    const steps = demoCdpSteps();
    const headless = this.configService.get<string>('CDP_HEADLESS') === 'true';
    const slowMo = Number(this.configService.get<string>('CDP_SLOW_MO') ?? 0);
    const stepDelayMs = Number(
      this.configService.get<string>('CDP_STEP_DELAY_MS') ?? 1000,
    );

    if (!this.supabaseScreenshots.isConfigured(supabase)) {
      const message = this.supabaseScreenshots.missingConfigMessage();
      callbacks.onLog('run', message);
      throw new Error(message);
    }

    const { runId, dir } =
      this.screenshotStorage.createRunDirectory(workspacePath);
    this.screenshotStorage.registerRunLocation(runId, dir);

    callbacks.onLog(
      'run',
      `CDP run ${runId} started (headless=${headless}, slowMo=${slowMo}, stepDelayMs=${stepDelayMs}).`,
    );
    callbacks.onLog('run', `Target frontend: ${baseUrl}`);
    callbacks.onLog('run', `Total demo steps: ${steps.length}`);
    callbacks.onLog('run', 'Screenshot storage: Supabase (public URLs).');

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
      callbacks.onLog('run', 'Launching Chromium…');
      browser = await chromium.launch({ headless, slowMo });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();
      callbacks.onLog(
        'run',
        `Chromium ready (viewport 1280×720, headless=${headless}).`,
      );

      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        callbacks.onStep(step.id, step.label);
        callbacks.onLog(
          step.id,
          `Step "${step.label}" — ${step.actions.length} action(s).`,
        );

        for (const action of step.actions) {
          const actionDesc = describeAction(action, baseUrl);
          callbacks.onLog(step.id, `Executing: ${actionDesc}`);
          await this.executeAction(page, action, baseUrl, (msg) =>
            callbacks.onLog(step.id, msg),
          );
          callbacks.onLog(step.id, `Completed: ${actionDesc}`);
        }

        callbacks.onLog(step.id, 'Capturing screenshot…');
        const buffer = await page.screenshot({
          type: 'jpeg',
          quality: 85,
          fullPage: false,
        });
        callbacks.onLog(step.id, 'Uploading screenshot to Supabase…');
        const url = await this.supabaseScreenshots.uploadPng(
          runId,
          step.id,
          buffer,
          supabase,
        );
        callbacks.onScreenshot(step.id, url);
        callbacks.onLog(step.id, `Screenshot uploaded (${url}).`);

        if (i < steps.length - 1 && stepDelayMs > 0) {
          callbacks.onLog(
            step.id,
            `Waiting ${stepDelayMs}ms before next step…`,
          );
          await sleep(stepDelayMs);
        }
      }

      callbacks.onLog('run', 'Demo flow finished successfully.');
      callbacks.onComplete('success');
      this.logger.log(`CDP run ${runId} completed for ${baseUrl}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDP run failed: ${message}`);
      callbacks.onLog('run', `CDP run failed: ${message}`);
      callbacks.onComplete('fail');
    } finally {
      if (browser) {
        callbacks.onLog('run', 'Closing Chromium browser…');
        await browser.close().catch(() => undefined);
        callbacks.onLog('run', 'Chromium closed.');
      }
    }
  }

  private async executeAction(
    page: Page,
    action: CdpAction,
    baseUrl: string,
    onDetail: (message: string) => void,
  ): Promise<void> {
    switch (action.type) {
      case 'navigate': {
        const pathPart = action.path ?? '/';
        const url = pathPart.startsWith('http')
          ? pathPart
          : `${baseUrl.replace(/\/$/, '')}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`;
        onDetail(`Navigating to ${url}…`);
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        onDetail(`Navigation complete (${url}).`);
        return;
      }
      case 'click':
        onDetail(
          `Clicking first matching selector from [${action.selectors.join(', ')}]…`,
        );
        await this.clickFirstMatch(page, action.selectors);
        onDetail('Click action completed.');
        return;
      case 'fill':
        onDetail(
          `Filling first matching selector from [${action.selectors.join(', ')}] with value "${action.value}"…`,
        );
        await this.fillFirstMatch(page, action.selectors, action.value);
        onDetail('Fill action completed.');
        return;
      case 'waitForText':
        onDetail(`Waiting for visible text "${action.text}"…`);
        await page
          .getByText(action.text, { exact: false })
          .first()
          .waitFor({
            state: 'visible',
            timeout: action.timeoutMs ?? 15_000,
          });
        onDetail(`Text "${action.text}" is visible.`);
        return;
      case 'waitForPath': {
        const fragment = action.pathIncludes;
        const timeout = action.timeoutMs ?? 15_000;
        onDetail(
          `Waiting for URL pathname to include "${fragment}" (timeout ${timeout}ms)…`,
        );
        await page.waitForURL((url) => url.pathname.includes(fragment), {
          timeout,
        });
        onDetail(`URL pathname now includes "${fragment}".`);
        return;
      }
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown action: ${String(_exhaustive)}`);
      }
    }
  }

  private async clickFirstMatch(
    page: Page,
    selectors: string[],
  ): Promise<void> {
    let lastError: Error | undefined;
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 8_000 });
        await locator.click({ timeout: 5_000 });
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error('No matching click target');
  }

  private async fillFirstMatch(
    page: Page,
    selectors: string[],
    value: string,
  ): Promise<void> {
    let lastError: Error | undefined;
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 8_000 });
        await locator.fill(value, { timeout: 5_000 });
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error('No matching fill target');
  }
}
