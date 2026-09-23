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
  } else {
    // No explicit status filter: hide dismissed items so the default view stays
    // actionable. They remain reachable via the 'Dismissed' filter.
    whereClause += ` AND status <> 'dismissed'`;
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
  } else {
    // No explicit status filter: hide dismissed items so the default view stays
    // actionable. They remain reachable via the 'Dismissed' filter.
    whereClause += ` AND status <> 'dismissed'`;
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

// ─── PUT /api/intelligence/items/:id ─────────────────────────────────────────

/**
 * Update the status of any intelligence item, whatever its category.
 * The older /ai-news/:id route is category-locked, which left publishing and
 * writing-job items impossible to dismiss.
 */
intelligenceRouter.put('/items/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['new', 'reviewed', 'selected', 'saved', 'dismissed'];
  if (!status || !validStatuses.includes(status)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid status');
  }

  const result = await query(
    `UPDATE intelligence_items
     SET status = $1, reviewed_at = NOW()
     WHERE id = $2
     RETURNING id, status`,
    [status, id]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Intelligence item not found');
  }

  res.json(result.rows[0]);
}));

// ─── POST /api/intelligence/dismiss-expired ──────────────────────────────────

/**
 * Bulk-dismiss items whose deadline has passed. Optionally scoped to one
 * category. Items with no deadline are never touched — an open reading period
 * with no stated close date is still live.
 */
intelligenceRouter.post('/dismiss-expired', asyncHandler(async (req: Request, res: Response) => {
  const { category } = req.body as { category?: string };

  const validCategories = ['grant', 'ai_news', 'publishing', 'writing_jobs'];
  const params: unknown[] = [];
  let categoryClause = '';
  if (category) {
    if (!validCategories.includes(category)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid category');
    }
    categoryClause = ` AND category = $1`;
    params.push(category);
  }

  const result = await query<{ id: string }>(
    `UPDATE intelligence_items
     SET status = 'dismissed', reviewed_at = NOW()
     WHERE deadline IS NOT NULL
       AND deadline < CURRENT_DATE
       AND status <> 'dismissed'
       ${categoryClause}
     RETURNING id`,
    params
  );

  res.json({ dismissedCount: result.rows.length });
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
  } else {
    // No explicit status filter: hide dismissed items so the default view stays
    // actionable. They remain reachable via the 'Dismissed' filter.
    whereClause += ` AND status <> 'dismissed'`;
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

/**
 * List writing job items. Deadline-bearing items first, then newest.
 */
intelligenceRouter.get('/writing-jobs', asyncHandler(async (req: Request, res: Response) => {
  const { status, subcategory, limit = '50', offset = '0' } = req.query;

  let whereClause = `WHERE category = 'writing_jobs'`;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status && typeof status === 'string') {
    whereClause += ` AND status = $${paramIdx}`;
    params.push(status);
    paramIdx++;
  } else {
    // No explicit status filter: hide dismissed items so the default view stays
    // actionable. They remain reachable via the 'Dismissed' filter.
    whereClause += ` AND status <> 'dismissed'`;
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

// ─── POST /api/intelligence/scan ─────────────────────────────────────────────

/**
 * Manually run a scanner now, instead of waiting for its cron schedule.
 * Runs synchronously so the caller learns how many new items were stored —
 * useful for verifying a source actually works.
 */
intelligenceRouter.post('/scan', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { category } = req.body as { category?: string };

  const validCategories = ['grant', 'ai_news', 'publishing', 'writing_jobs'];
  if (!category || !validCategories.includes(category)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `category must be one of: ${validCategories.join(', ')}`
    );
  }

  let storedCount = 0;
  if (category === 'grant') {
    const { runGrantScanner } = await import('../jobs/grant-scanner.job.js');
    storedCount = await runGrantScanner(userId);
  } else if (category === 'ai_news') {
    const { runAiNewsScanner } = await import('../jobs/ai-news-scanner.job.js');
    storedCount = await runAiNewsScanner(userId);
  } else if (category === 'writing_jobs') {
    const { runWritingJobsScanner } = await import('../jobs/writing-jobs-scanner.job.js');
    storedCount = await runWritingJobsScanner(userId);
  } else {
    const { runPublishingScanner } = await import('../jobs/publishing-scanner.job.js');
    storedCount = await runPublishingScanner(userId);
  }

  res.json({ category, storedCount });
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
