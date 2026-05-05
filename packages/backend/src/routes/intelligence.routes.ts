import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';

export const intelligenceRouter = Router();

// All intelligence routes require authentication
intelligenceRouter.use(requireAuth);

// ─── GET /api/intelligence/grants ────────────────────────────────────────────

/**
 * List grant opportunities, filterable by status, sorted by deadline.
 */
intelligenceRouter.get('/grants', asyncHandler(async (req: Request, res: Response) => {
  const { status, limit = '50', offset = '0' } = req.query;

  let whereClause = `WHERE category = 'grant'`;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status && typeof status === 'string') {
    whereClause += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_items ${whereClause}`,
    params
  );

  const result = await query(
    `SELECT id, category, subcategory, title, source, source_name, summary,
            relevance_score, deadline, eligibility_summary, award_details,
            status, published_at, discovered_at, reviewed_at
     FROM intelligence_items
     ${whereClause}
     ORDER BY
       CASE WHEN deadline IS NOT NULL THEN 0 ELSE 1 END,
       deadline ASC,
       relevance_score DESC,
       discovered_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, parseInt(limit as string, 10), parseInt(offset as string, 10)]
  );

  res.json({
    items: result.rows,
    total: parseInt(countResult.rows[0]?.count || '0', 10),
  });
}));

// ─── GET /api/intelligence/ai-news ──────────────────────────────────────────

/**
 * List curated AI news items, sorted by relevance score.
 */
intelligenceRouter.get('/ai-news', asyncHandler(async (req: Request, res: Response) => {
  const { status, limit = '50', offset = '0' } = req.query;

  let whereClause = `WHERE category = 'ai_news'`;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status && typeof status === 'string') {
    whereClause += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_items ${whereClause}`,
    params
  );

  const result = await query(
    `SELECT id, category, subcategory, title, source, source_name, summary,
            relevance_score, deadline, status, published_at, discovered_at, reviewed_at
     FROM intelligence_items
     ${whereClause}
     ORDER BY relevance_score DESC, discovered_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, parseInt(limit as string, 10), parseInt(offset as string, 10)]
  );

  res.json({
    items: result.rows,
    total: parseInt(countResult.rows[0]?.count || '0', 10),
  });
}));

// ─── PUT /api/intelligence/ai-news/:id ──────────────────────────────────────

/**
 * Update the status of an AI news item.
 */
intelligenceRouter.put('/ai-news/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['new', 'reviewed', 'selected', 'saved', 'dismissed'];
  if (!status || !validStatuses.includes(status)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid status');
  }

  const result = await query(
    `UPDATE intelligence_items
     SET status = $1, reviewed_at = NOW()
     WHERE id = $2 AND category = 'ai_news'
     RETURNING id, status`,
    [status, id]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'AI news item not found');
  }

  res.json(result.rows[0]);
}));

// ─── GET /api/intelligence/publishing ────────────────────────────────────────

/**
 * List publishing intelligence items, sorted by date relevance.
 */
intelligenceRouter.get('/publishing', asyncHandler(async (req: Request, res: Response) => {
  const { status, subcategory, limit = '50', offset = '0' } = req.query;

  let whereClause = `WHERE category = 'publishing'`;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status && typeof status === 'string') {
    whereClause += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  }

  if (subcategory && typeof subcategory === 'string') {
    whereClause += ` AND subcategory = $${paramIdx}`;
    params.push(subcategory);
    paramIdx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM intelligence_items ${whereClause}`,
    params
  );

  const result = await query(
    `SELECT id, category, subcategory, title, source, source_name, summary,
            relevance_score, deadline, status, published_at, discovered_at, reviewed_at
     FROM intelligence_items
     ${whereClause}
     ORDER BY
       CASE WHEN deadline IS NOT NULL THEN 0 ELSE 1 END,
       deadline ASC,
       discovered_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...params, parseInt(limit as string, 10), parseInt(offset as string, 10)]
  );

  res.json({
    items: result.rows,
    total: parseInt(countResult.rows[0]?.count || '0', 10),
  });
}));

// ─── GET /api/intelligence/config ────────────────────────────────────────────

/**
 * Get job schedules and sources configuration.
 */
intelligenceRouter.get('/config', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
    `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
    [userId]
  );

  const schedules = result.rows[0]?.intelligence_schedules || {
    grant_scanner: '0 6 * * *',
    ai_news_scanner: '0 */6 * * *',
    publishing_scanner: '0 7 * * *',
  };

  res.json({ schedules });
}));

// ─── PUT /api/intelligence/config ────────────────────────────────────────────

/**
 * Update job schedules and sources configuration.
 */
intelligenceRouter.put('/config', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { schedules } = req.body;

  if (!schedules || typeof schedules !== 'object') {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'schedules object is required');
  }

  // Validate cron expressions
  const cron = await import('node-cron');
  for (const [key, value] of Object.entries(schedules)) {
    if (typeof value === 'string' && !cron.validate(value)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Invalid cron expression for ${key}: ${value}`
      );
    }
  }

  await query(
    `UPDATE settings
     SET intelligence_schedules = $1
     WHERE user_id = $2`,
    [JSON.stringify(schedules), userId]
  );

  res.json({ schedules });
}));
