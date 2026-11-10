import { BadRequestError, NotFoundError } from '../lib/http-error';
import { createLogger } from '../lib/logger';
import { ContextService } from '../context/context.service';
import { WorkspaceConfigValidator } from '../context/workspace-config.validator';
import { SupabaseScreenshotService } from '../cdp/supabase-screenshot.service';
import { TursorAiClient } from '../tursor-ai/tursor-ai.client';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { SupabaseSuiteService } from './supabase-suite.service';
import { SuiteService } from './suite.service';

export type ReportFormat = 'md' | 'pdf';

export type GeneratedReport = {
  reportId: string;
  suiteId: string;
  format: ReportFormat;
  filename: string;
  contentType: string;
  /** The file itself, so the extension can save it without fetching the URL. */
  encoding: 'utf-8' | 'base64';
  content: string;
  url: string;
  metrics: {
    total: number;
    executed: number;
    passed: number;
    failed: number;
    not_run: number;
    runs: number;
  };
};

/** Suite-level report: the suite's cases and every run of them, as Markdown or PDF. */
export class ReportService {
  private readonly logger = createLogger('ReportService');

  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
    private readonly suites: SuiteService,
    private readonly store: SupabaseSuiteService,
    private readonly storage: SupabaseScreenshotService,
    private readonly tursorAi: TursorAiClient,
    private readonly gateway: WebsocketGateway,
  ) {}

  async generate(input: {
    suiteId: string;
    conversationId: string | null;
    format: ReportFormat;
  }): Promise<GeneratedReport> {
    const workspacePath = this.contextService.getWorkspacePath();
    if (!workspacePath) {
      throw new BadRequestError(
        'No workspace path. Connect from the extension.',
      );
    }
    const validated = this.validator.validate(workspacePath);
    if (!validated.ok) {
      throw new BadRequestError(validated.error);
    }
    const database = validated.supabase.database;
    const detail = await this.suites.getDetail(database, input.suiteId, {
      withRuns: true,
    });
    if (!detail || detail.suite.workspacePath !== workspacePath) {
      throw new NotFoundError(`Test suite ${input.suiteId} not found`);
    }
    const prd = detail.suite.prdId
      ? await this.store.getPrd(database, detail.suite.prdId)
      : null;

    const runCount = detail.cases.reduce(
      (sum, item) => sum + item.runs.length,
      0,
    );
    this.gateway.emitRunLog({
      category: 'report',
      level: 'info',
      message:
        `Building a ${input.format.toUpperCase()} report for ${detail.module.name || detail.module.moduleKey} ` +
        `v${detail.suite.version}: ${detail.cases.length} cases, ${runCount} runs` +
        (prd ? `, PRD “${prd.title}”.` : '.'),
      meta: { suiteId: detail.suite.id, version: detail.suite.version },
    });
    await this.tursorAi.ensureReady();
    const report = await this.tursorAi.generateReport({
      format: input.format,
      workspace_path: workspacePath,
      generation_model: validated.ai?.generationModel ?? '',
      api_key: validated.ai?.apiKey ?? '',
      suite: {
        suite_id: detail.suite.id,
        module_key: detail.module.moduleKey,
        module_name: detail.module.name,
        feature: detail.suite.feature,
        version: detail.suite.version,
        created_at: detail.suite.createdAt,
        cases: detail.cases.map((item) => ({
          case_id: item.id,
          kind: item.kind,
          title: item.title,
          explanation: item.explanation,
          requirement_ids: item.requirementIds,
          steps: item.steps,
          runs: item.runs
            .filter((run) => run.status !== 'running')
            .map((run) => ({
              run_id: run.id,
              status: run.status === 'passed' ? 'passed' : 'failure',
              status_message: run.statusMessage,
              failed_step: run.failedStep,
              run_folder: run.runFolder,
              screenshots: run.screenshots,
              started_at: run.startedAt,
              finished_at: run.finishedAt ?? '',
            })),
        })),
      },
      prd: prd
        ? {
            title: prd.title,
            verdict: prd.verdict,
            requirements: prd.requirements.map((item) => ({
              id: item.id,
              text: item.text,
              status: item.status,
              gap: item.gap,
            })),
          }
        : null,
    });

    const body =
      report.encoding === 'base64'
        ? Buffer.from(report.content, 'base64')
        : Buffer.from(report.content, 'utf8');
    const storagePath = `reports/${detail.suite.id}/${Date.now()}_${report.filename}`;
    let url = '';
    try {
      url = await this.storage.uploadReport(
        validated.supabase.bucket,
        storagePath,
        body,
        report.content_type,
      );
    } catch (err) {
      // The report is still returned for download; only the stored copy is missing.
      const detailText = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Report upload failed: ${detailText}`);
      this.gateway.emitRunLog({
        category: 'report',
        level: 'warn',
        message: `Report was not stored in the bucket (${detailText}); it is still downloaded.`,
      });
    }
    const saved = url
      ? await this.store.insertReport(database, {
          suiteId: detail.suite.id,
          conversationId: input.conversationId,
          format: report.format,
          filename: report.filename,
          storagePath,
          url,
        })
      : null;

    if (saved) {
      this.gateway.emitRunLog({
        category: 'report',
        level: 'success',
        message: `Report ${report.filename} stored at ${storagePath}.`,
        meta: { reportId: saved.id, storagePath },
      });
    }
    return {
      reportId: saved?.id ?? '',
      suiteId: detail.suite.id,
      format: report.format,
      filename: report.filename,
      contentType: report.content_type,
      encoding: report.encoding,
      content: report.content,
      url,
      metrics: report.metrics,
    };
  }
}
