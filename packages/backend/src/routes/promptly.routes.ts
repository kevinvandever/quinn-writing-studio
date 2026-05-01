import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { startSession } from '../services/coaching.service.js';

export const promptlyRouter = Router();

// All promptly routes require authentication
promptlyRouter.use(requireAuth);

// ─── GET /api/promptly/queue ─────────────────────────────────────────────────

/**
 * List content queue items for the Promptly workflow.
 * Returns items with their associated intelligence item details.
 */
promptlyRouter.get('/queue', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { status, projectId } = req.query;

  let whereClause = `WHERE p.user_id = $1`;
  const params: unknown[] = [userId];
  let paramIdx = 2;

  if (status && typeof status === 'string') {
    whereClause += ` AND pqi.status = ${paramIdx}`;
    params.push(status);
    paramIdx++;
  }

  if (projectId && typeof projectId === 'string') {
    whereClause += ` AND pqi.project_id = ${paramIdx}`;
    params.push(projectId);
    paramIdx++;
  }

  const result = await query(
    `SELECT pqi.id, pqi.project_id, pqi.intelligence_item_id, pqi.status,
            pqi.substack_post_id, pqi.coaching_session_id, pqi.notes,
            pqi.selected_at, pqi.published_at,
            ii.title as news_title, ii.source as news_source,
            ii.source_name as news_source_name, ii.summary as news_summary,
            ii.relevance_score as news_relevance_score,
            ii.subcategory as news_subcategory
     FROM promptly_queue_items pqi
     JOIN intelligence_items ii ON pqi.intelligence_item_id = ii.id
     JOIN projects p ON pqi.project_id = p.id
     ${whereClause}
     ORDER BY
       CASE pqi.status
         WHEN 'in_progress' THEN 0
         WHEN 'selected' THEN 1
         WHEN 'published' THEN 2
         WHEN 'dropped' THEN 3
       END,
       pqi.selected_at DESC`,
    params
  );

  res.json({ items: result.rows });
}));

// ─── POST /api/promptly/queue/:newsId/select ─────────────────────────────────

/**
 * Move a news item from the intelligence feed to the Promptly content queue.
 * Creates a new queue item linked to the intelligence item.
 */
promptlyRouter.post('/queue/:newsId/select', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { newsId } = req.params;
  const { projectId } = req.body;

  // Verify the intelligence item exists and is AI news
  const newsResult = await query<{ id: string; category: string }>(
    `SELECT id, category FROM intelligence_items WHERE id = $1`,
    [newsId]
  );

  if (newsResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Intelligence item not found');
  }

  // Find the Promptly project (or use provided projectId)
  let targetProjectId = projectId;
  if (!targetProjectId) {
    const projectResult = await query<{ id: string }>(
      `SELECT id FROM projects
       WHERE user_id = $1 AND project_type = 'promptly'
       LIMIT 1`,
      [userId]
    );

    if (projectResult.rows.length === 0) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'No Promptly project found. Create a project with type "promptly" first.'
      );
    }

    targetProjectId = projectResult.rows[0]!.id;
  }

  // Check for duplicate
  const existingResult = await query<{ id: string }>(
    `SELECT id FROM promptly_queue_items
     WHERE intelligence_item_id = $1 AND project_id = $2`,
    [newsId, targetProjectId]
  );

  if (existingResult.rows.length > 0) {
    throw new AppError(409, ErrorCodes.CONFLICT, 'This item is already in the queue');
  }

  // Create queue item
  const result = await query(
    `INSERT INTO promptly_queue_items (project_id, intelligence_item_id, status, selected_at)
     VALUES ($1, $2, 'selected', NOW())
     RETURNING id, project_id, intelligence_item_id, status, selected_at`,
    [targetProjectId, newsId]
  );

  // Update intelligence item status to 'selected'
  await query(
    `UPDATE intelligence_items SET status = 'selected', reviewed_at = NOW() WHERE id = $1`,
    [newsId]
  );

  res.status(201).json(result.rows[0]);
}));

// ─── PUT /api/promptly/queue/:id ─────────────────────────────────────────────

/**
 * Update a queue item's status or notes.
 */
promptlyRouter.put('/queue/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;
  const { status, notes, substackPostId } = req.body;

  // Verify ownership
  const existingResult = await query<{ id: string; project_id: string }>(
    `SELECT pqi.id, pqi.project_id
     FROM promptly_queue_items pqi
     JOIN projects p ON pqi.project_id = p.id
     WHERE pqi.id = $1 AND p.user_id = $2`,
    [id, userId]
  );

  if (existingResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Queue item not found');
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (status) {
    const validStatuses = ['selected', 'in_progress', 'published', 'dropped'];
    if (!validStatuses.includes(status)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid status');
    }
    updates.push(`status = ${paramIdx}`);
    params.push(status);
    paramIdx++;

    if (status === 'published') {
      updates.push(`published_at = NOW()`);
    }
  }

  if (notes !== undefined) {
    updates.push(`notes = ${paramIdx}`);
    params.push(notes);
    paramIdx++;
  }

  if (substackPostId !== undefined) {
    updates.push(`substack_post_id = ${paramIdx}`);
    params.push(substackPostId);
    paramIdx++;
  }

  if (updates.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'No updates provided');
  }

  params.push(id);
  const result = await query(
    `UPDATE promptly_queue_items
     SET ${updates.join(', ')}
     WHERE id = ${paramIdx}
     RETURNING id, project_id, intelligence_item_id, status, substack_post_id, coaching_session_id, notes, selected_at, published_at`,
    params
  );

  res.json(result.rows[0]);
}));

// ─── POST /api/promptly/queue/:id/coach ──────────────────────────────────────

/**
 * Start a Promptly coaching session for a queue item.
 * Creates a new coaching session with type 'promptly_coaching' and links it to the queue item.
 */
promptlyRouter.post('/queue/:id/coach', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;

  // Verify ownership and get queue item details
  const queueResult = await query<{
    id: string;
    project_id: string;
    intelligence_item_id: string;
    coaching_session_id: string | null;
  }>(
    `SELECT pqi.id, pqi.project_id, pqi.intelligence_item_id, pqi.coaching_session_id
     FROM promptly_queue_items pqi
     JOIN projects p ON pqi.project_id = p.id
     WHERE pqi.id = $1 AND p.user_id = $2`,
    [id, userId]
  );

  if (queueResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Queue item not found');
  }

  const queueItem = queueResult.rows[0]!;

  // Start a new coaching session with type 'promptly_coaching'
  const sessionContext = await startSession(userId, queueItem.project_id, 'promptly_coaching');

  // Link the session to the queue item
  await query(
    `UPDATE promptly_queue_items
     SET coaching_session_id = $1, status = 'in_progress'
     WHERE id = $2`,
    [sessionContext.sessionId, id]
  );

  res.status(201).json({
    sessionId: sessionContext.sessionId,
    projectId: queueItem.project_id,
    queueItemId: id,
    intelligenceItemId: queueItem.intelligence_item_id,
  });
}));
