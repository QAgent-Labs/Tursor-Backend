import * as fs from 'node:fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContainer } from './container';
import { HttpError } from './lib/http-error';
import { config } from './lib/config';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

export function createRoutes(app: AppContainer): Router {
  const router = Router();

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
      const result = await app.runOrchestrator.bootstrapWorkspace(workspacePath);
      res.json(result);
    }),
  );

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
      res.json(await app.chatOrchestrator.intro(workspacePath));
    }),
  );

  router.post(
    '/chat/message',
    asyncHandler(async (req, res) => {
      const { conversationId, message, workspacePath } = req.body ?? {};
      res.json(
        await app.chatOrchestrator.postMessage(
          conversationId,
          message,
          workspacePath,
        ),
      );
    }),
  );

  router.post(
    '/chat/approve-test-flow',
    asyncHandler(async (req, res) => {
      res.json(
        await app.chatOrchestrator.approveTestFlow(req.body.conversationId),
      );
    }),
  );

  router.post(
    '/chat/approve-execution',
    asyncHandler(async (req, res) => {
      res.json(
        await app.chatOrchestrator.approveExecution(req.body.conversationId),
      );
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
