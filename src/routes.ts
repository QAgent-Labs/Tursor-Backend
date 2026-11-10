import * as fs from 'node:fs';
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import type { AppContainer } from './container';
import { BadRequestError, HttpError, NotFoundError } from './lib/http-error';
import { isUuid } from './chat/chat-orchestrator.service';
import { config } from './lib/config';
import { withTrace, type TraceKind } from './lib/trace';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_INGEST_EVENTS = 200;

function preview(text: unknown): string {
  const value =
    typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  return value.length > 48 ? `${value.slice(0, 47)}…` : value;
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

export function createRoutes(app: AppContainer): Router {
  const router = Router();

  /** Run a request in a trace; a failure is logged to the panel inside that trace. */
  const traced = <T>(kind: TraceKind, label: string, fn: () => Promise<T>) =>
    withTrace(kind, label, async () => {
      try {
        return await fn();
      } catch (err) {
        app.wsGateway.emitRunLog({
          category: 'error',
          level: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', port: config.port });
  });

  router.get('/context/current', (_req, res) => {
    res.json(app.contextService.getWorkspaceContext());
  });

  router.get('/context/validate', (_req, res) => {
    const path = app.contextService.getWorkspacePath();
    if (!path) {
      res.json({ ok: false, error: 'No workspace path set.' });
      return;
    }
    const result = app.validator.validate(path);
    if (!result.ok) {
      res.json({ ok: false, error: result.error });
      return;
    }
    res.json({
      ok: true,
      configPath: result.configPath,
      excluded: result.excluded,
      aiConfigured: result.ai !== null,
      generationModel: result.ai?.generationModel ?? null,
    });
  });

  router.post(
    '/context/bootstrap',
    asyncHandler(async (req, res) => {
      const workspacePath =
        typeof req.body?.workspacePath === 'string'
          ? req.body.workspacePath.trim()
          : '';
      const result = await traced('context', 'Bootstrap workspace', () =>
        app.runOrchestrator.bootstrapWorkspace(workspacePath),
      );
      res.json(result);
    }),
  );

  // Tursor-AI posts its log events here; they are relayed to the extension's log panel.
  router.post('/logs/ingest', (req, res, next) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      next(
        new HttpError(
          403,
          'Logs are accepted from this machine only',
          'Forbidden',
        ),
      );
      return;
    }
    const events = (req.body as { events?: unknown })?.events;
    if (!Array.isArray(events)) {
      next(new BadRequestError('events must be an array'));
      return;
    }
    const relayed = app.wsGateway.relayAiLogs(
      events.slice(0, MAX_INGEST_EVENTS),
    );
    res.json({ ok: true, relayed });
  });

  router.post('/context/update', (req, res) => {
    const changedPath =
      typeof req.body?.path === 'string' && req.body.path.trim()
        ? req.body.path.trim()
        : undefined;
    app.runOrchestrator.scheduleIncrementalEmbed(changedPath);
    res.json({ ok: true, queued: true });
  });

  router.post(
    '/chat/intro',
    asyncHandler(async (req, res) => {
      const workspacePath =
        typeof req.body?.workspacePath === 'string'
          ? req.body.workspacePath
          : undefined;
      res.json(
        await traced('chat', 'New conversation', () =>
          app.chatOrchestrator.intro(workspacePath),
        ),
      );
    }),
  );

  router.post(
    '/chat/message',
    asyncHandler(async (req, res) => {
      const { conversationId, message, workspacePath } = req.body ?? {};
      res.json(
        await traced('chat', `Chat · “${preview(message)}”`, () =>
          app.chatOrchestrator.postMessage(
            conversationId,
            message,
            workspacePath,
          ),
        ),
      );
    }),
  );

  router.post(
    '/chat/run',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const caseIds = Array.isArray(body.caseIds)
        ? body.caseIds.filter((id): id is string => typeof id === 'string')
        : undefined;
      if (caseIds && caseIds.length > 100) {
        throw new BadRequestError('Run at most 100 test cases at once.');
      }
      const suiteId =
        typeof body.suiteId === 'string' ? body.suiteId : undefined;
      const label = suiteId
        ? 'Run · whole suite'
        : `Run · ${caseIds?.length ?? 1} test case(s)`;
      // The run continues after this request returns; its logs keep this trace.
      res.json(
        await traced('run', label, () =>
          app.chatOrchestrator.runCases({
            conversationId:
              typeof body.conversationId === 'string'
                ? body.conversationId
                : '',
            caseIds,
            suiteId,
            cdpStepsId:
              typeof body.cdpStepsId === 'string' ? body.cdpStepsId : undefined,
          }),
        ),
      );
    }),
  );

  router.get(
    '/suites/:id',
    asyncHandler(async (req, res) => {
      const suiteId = String(req.params.id);
      if (!isUuid(suiteId)) {
        throw new BadRequestError('suite id must be a UUID');
      }
      const bundle = app.chatOrchestrator.activeBundle();
      const detail = await app.suites.getDetail(
        bundle.supabase.database,
        suiteId,
        { withRuns: true },
      );
      if (!detail || detail.suite.workspacePath !== bundle.workspacePath) {
        throw new NotFoundError(`Test suite ${suiteId} not found`);
      }
      const rank = await app.suites.versionRank(
        bundle.supabase.database,
        detail.suite,
      );
      res.json({ ...detail, rank });
    }),
  );

  router.post(
    '/reports',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const suiteId = typeof body.suiteId === 'string' ? body.suiteId : '';
      if (!isUuid(suiteId)) {
        throw new BadRequestError('suiteId must be a UUID');
      }
      const conversationId =
        typeof body.conversationId === 'string' && isUuid(body.conversationId)
          ? body.conversationId
          : null;
      const format = body.format === 'pdf' ? 'pdf' : 'md';
      res.json(
        await traced('report', `Report · ${format.toUpperCase()}`, () =>
          app.reports.generate({ suiteId, conversationId, format }),
        ),
      );
    }),
  );

  router.get(
    '/chat/conversations',
    asyncHandler(async (req, res) => {
      const workspacePath =
        typeof req.query.workspacePath === 'string'
          ? req.query.workspacePath
          : undefined;
      res.json(await app.chatOrchestrator.listConversations(workspacePath));
    }),
  );

  router.get(
    '/chat/conversations/:id',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      res.json(await app.chatOrchestrator.getConversation(id));
    }),
  );

  router.get('/screenshots/:runId/:filename', (req, res, next) => {
    const runId = String(req.params.runId);
    const filename = String(req.params.filename);
    const filePath = app.screenshotStorage.resolveFilePathWithIndex(
      runId,
      filename,
    );
    if (!filePath || !fs.existsSync(filePath)) {
      next(new HttpError(404, 'Screenshot not found', 'Not Found'));
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  });

  return router;
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      statusCode: err.statusCode,
      message: err.message,
      error: err.error,
    });
    return;
  }
  console.error(err);
  res.status(500).json({
    statusCode: 500,
    message: 'Internal server error',
    error: 'Internal Server Error',
  });
}
