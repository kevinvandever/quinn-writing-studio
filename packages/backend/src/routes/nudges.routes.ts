/**
 * Nudges Routes
 *
 * Provides nudge listing, acknowledgment, and vacation mode endpoints.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { query } from '../db/connection.js';
import { getPendingNudges, acknowledgeNudge } from '../services/notification.service.js';

const router = Router();

// Apply auth middleware to all nudge routes
router.use(requireAuth);

/**
 * GET /api/nudges
 * List pending (unacknowledged) nudges for the current user.
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const nudges = await getPendingNudges(userId);

  res.json({ nudges });
}));

/**
 * PUT /api/nudges/:id/acknowledge
 * Mark a nudge as seen/acknowledged.
 */
router.put('/:id/acknowledge', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const nudgeId = req.params.id as string;

  const success = await acknowledgeNudge(nudgeId, userId);

  if (!success) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Nudge not found or already acknowledged');
  }

  res.json({ acknowledged: true });
}));

/**
 * POST /api/settings/vacation
 * Set a planned break period (vacation mode).
 * Body: { start_date: string, end_date: string } or { clear: true }
 */
router.post('/vacation', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { start_date, end_date, clear } = req.body;

  if (clear) {
    await query(
      `UPDATE settings SET vacation_start = NULL, vacation_end = NULL WHERE user_id = $1`,
      [userId]
    );

    res.json({ vacation: null, message: 'Vacation mode cleared' });
    return;
  }

  if (!start_date || !end_date) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'start_date and end_date are required');
  }

  const startDate = new Date(start_date);
  const endDate = new Date(end_date);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Invalid date format');
  }

  if (endDate <= startDate) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'end_date must be after start_date');
  }

  // Upsert settings with vacation dates
  await query(
    `INSERT INTO settings (user_id, vacation_start, vacation_end)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET vacation_start = $2, vacation_end = $3`,
    [userId, startDate, endDate]
  );

  res.json({
    vacation: { start_date: startDate, end_date: endDate },
    message: 'Vacation mode set',
  });
}));

export const nudgesRouter = router;
