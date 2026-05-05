import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';

const router = Router();

// Apply auth middleware to all capture routes
router.use(requireAuth);

const createCaptureSchema = z.object({
  content: z.string().min(1, 'Content is required'),
  project_id: z.string().uuid().optional(),
});

const updateCaptureSchema = z.object({
  content: z.string().min(1).optional(),
  project_id: z.string().uuid().nullable().optional(),
  status: z.enum(['inbox', 'triaged', 'dismissed']).optional(),
});

/**
 * POST /api/captures
 * Create a new quick capture. Status defaults to 'inbox'.
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const data = createCaptureSchema.parse(req.body);

  const result = await query<{
    id: string;
    user_id: string;
    project_id: string | null;
    content: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO quick_captures (user_id, content, project_id)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, project_id, content, status, created_at`,
    [userId, data.content, data.project_id ?? null]
  );

  const capture = result.rows[0]!;

  // Log capture_created activity event
  await query(
    `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
     VALUES ($1, $2, 'capture_created', $3)`,
    [userId, capture.project_id, JSON.stringify({ capture_id: capture.id, project_id: capture.project_id })]
  );

  res.status(201).json({ capture });
}));

/**
 * GET /api/captures
 * List captures for the authenticated user.
 * Filterable by: project_id, status, from (date), to (date)
 * Supports pagination via: limit, offset
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { project_id, status, from, to, limit, offset } = req.query;

  const conditions: string[] = ['user_id = $1'];
  const values: unknown[] = [userId];
  let paramIndex = 2;

  if (project_id) {
    conditions.push(`project_id = $${paramIndex}`);
    values.push(project_id);
    paramIndex++;
  }

  if (status) {
    conditions.push(`status = $${paramIndex}`);
    values.push(status);
    paramIndex++;
  }

  if (from) {
    conditions.push(`created_at >= $${paramIndex}`);
    values.push(from);
    paramIndex++;
  }

  if (to) {
    conditions.push(`created_at <= $${paramIndex}`);
    values.push(to);
    paramIndex++;
  }

  const limitVal = Math.min(Number(limit) || 50, 100);
  const offsetVal = Number(offset) || 0;

  const whereClause = conditions.join(' AND ');

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM quick_captures WHERE ${whereClause}`,
    values
  );

  const result = await query<{
    id: string;
    user_id: string;
    project_id: string | null;
    content: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, user_id, project_id, content, status, created_at
     FROM quick_captures
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...values, limitVal, offsetVal]
  );

  const totalCount = countResult.rows[0]?.count ?? '0';

  res.json({
    captures: result.rows,
    total: parseInt(totalCount, 10),
    limit: limitVal,
    offset: offsetVal,
  });
}));

/**
 * PUT /api/captures/:id
 * Update a capture (change project_id, status, content). Verifies ownership.
 */
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const captureId = req.params.id;
  const data = updateCaptureSchema.parse(req.body);

  // Build dynamic SET clause
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.content !== undefined) {
    setClauses.push(`content = $${paramIndex}`);
    values.push(data.content);
    paramIndex++;
  }

  if (data.project_id !== undefined) {
    setClauses.push(`project_id = $${paramIndex}`);
    values.push(data.project_id);
    paramIndex++;
  }

  if (data.status !== undefined) {
    setClauses.push(`status = $${paramIndex}`);
    values.push(data.status);
    paramIndex++;
  }

  if (setClauses.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'No fields to update');
  }

  values.push(captureId);
  const captureIdParam = paramIndex;
  paramIndex++;
  values.push(userId);
  const userIdParam = paramIndex;

  const result = await query<{
    id: string;
    user_id: string;
    project_id: string | null;
    content: string;
    status: string;
    created_at: Date;
  }>(
    `UPDATE quick_captures
     SET ${setClauses.join(', ')}
     WHERE id = $${captureIdParam} AND user_id = $${userIdParam}
     RETURNING id, user_id, project_id, content, status, created_at`,
    values
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Capture not found');
  }

  res.json({ capture: result.rows[0] });
}));

/**
 * DELETE /api/captures/:id
 * Delete a capture. Verifies ownership.
 */
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const captureId = req.params.id;

  const result = await query(
    `DELETE FROM quick_captures WHERE id = $1 AND user_id = $2`,
    [captureId, userId]
  );

  if (result.rowCount === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Capture not found');
  }

  res.status(204).send();
}));

export const capturesRouter = router;
