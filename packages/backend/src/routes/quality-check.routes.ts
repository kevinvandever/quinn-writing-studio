/**
 * Quality Check Routes
 *
 * Runs one quality-check case at a time for the local runner
 * (tools/quality-check.ts). See services/quality-check.service.ts.
 */
import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { claudeApiLimiter } from '../middleware/rate-limit.middleware.js';
import { qualityCaseSchema } from '../services/quality-check.schema.js';
import { runQualityCase } from '../services/quality-check.service.js';

const router = Router();

/**
 * POST /api/projects/:id/quality-check
 * Body: { case }. Runs the case as a fresh conversation with Quinn in this
 * project and grades it. Stores nothing but API usage. A case can take a few
 * minutes, so the response starts at once with a space every 15 seconds (to
 * keep proxies from closing a quiet connection), then the JSON result:
 * { result } or { error }.
 */
router.post(
  '/projects/:id/quality-check',
  requireAuth,
  claudeApiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const projectId = req.params.id as string;
    const parsed = qualityCaseSchema.safeParse((req.body as { case?: unknown } | undefined)?.case);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'case'}: ${i.message}`).join('; ');
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Invalid case: ${issues}`);
    }
    const owned = await query(
      'SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND archived_at IS NULL',
      [projectId, userId]
    );
    if (owned.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(' ');
    }, 15000);
    try {
      const result = await runQualityCase(userId, projectId, parsed.data);
      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    } finally {
      clearInterval(keepAlive);
    }
  })
);

export const qualityCheckRouter = router;
