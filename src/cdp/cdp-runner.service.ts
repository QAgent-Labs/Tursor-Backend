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
    callbacks: CdpRunCallbacks,
  ): Promise<void> {
    const baseUrl = `http://127.0.0.1:${frontendPort}`;
    const steps = demoCdpSteps();
    const headless = this.configService.get<string>('CDP_HEADLESS') !== 'false';
    const slowMo = Number(this.configService.get<string>('CDP_SLOW_MO') ?? 0);

    const { runId, dir } =
      this.screenshotStorage.createRunDirectory(workspacePath);
    this.screenshotStorage.registerRunLocation(runId, dir);
    const useSupabase = this.supabaseScreenshots.isConfigured();
    if (useSupabase) {
      callbacks.onLog(
        'run',
        '[CDP] Screenshots → Supabase Storage (public URLs)',
      );
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
      browser = await chromium.launch({ headless, slowMo });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      callbacks.onLog(
        'run',
        `[CDP] Launched Chromium (headless=${headless}) → ${baseUrl}`,
      );

      for (const step of steps) {
        callbacks.onStep(step.id, step.label);
        for (const action of step.actions) {
          callbacks.onLog(step.id, `[CDP] ${describeAction(action, baseUrl)}`);
          await this.executeAction(page, action, baseUrl);
        }
        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        let url: string;
        if (useSupabase) {
          url = await this.supabaseScreenshots.uploadPng(
            runId,
            step.id,
            buffer,
          );
        } else {
          this.screenshotStorage.savePng(dir, step.id, buffer);
          url = this.screenshotStorage.publicScreenshotUrl(runId, step.id);
        }
        callbacks.onScreenshot(step.id, url);
      }

      callbacks.onLog('run', '[CDP] Demo flow finished successfully.');
      callbacks.onComplete('success');
      this.logger.log(`CDP run ${runId} completed for ${baseUrl}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDP run failed: ${message}`);
      callbacks.onLog('run', `[CDP] Failed: ${message}`);
      callbacks.onComplete('fail');
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  private async executeAction(
    page: Page,
    action: CdpAction,
    baseUrl: string,
  ): Promise<void> {
    switch (action.type) {
      case 'navigate': {
        const pathPart = action.path ?? '/';
        const url = pathPart.startsWith('http')
          ? pathPart
          : `${baseUrl.replace(/\/$/, '')}${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`;
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        return;
      }
      case 'click':
        await this.clickFirstMatch(page, action.selectors);
        return;
      case 'fill':
        await this.fillFirstMatch(page, action.selectors, action.value);
        return;
      case 'waitForText':
        await page
          .getByText(action.text, { exact: false })
          .first()
          .waitFor({
            state: 'visible',
            timeout: action.timeoutMs ?? 15_000,
          });
        return;
      case 'waitForPath': {
        const fragment = action.pathIncludes;
        const timeout = action.timeoutMs ?? 15_000;
        await page.waitForURL((url) => url.pathname.includes(fragment), {
          timeout,
        });
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
