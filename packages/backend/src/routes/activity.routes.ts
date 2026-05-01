/**
 * Activity Routes
 *
 * Provides writing activity insights and publishing streaks.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import {
  getActivityInsights,
  getPublishingStreaks,
  type TimePeriod,
} from '../services/activity.service.js';

const router = Router();

// Apply auth middleware to all activity routes
router.use(requireAuth);

/**
 * GET /api/activity
 * Get activity insights for a configurable time period.
 * Query params: period (week | month | quarter, defaults to week)
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const period = (req.query.period as string) || 'week';

  // Validate period
  const validPeriods: TimePeriod[] = ['week', 'month', 'quarter'];
  if (!validPeriods.includes(period as TimePeriod)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Invalid period. Must be one of: week, month, quarter'
    );
  }

  const insights = await getActivityInsights(userId, period as TimePeriod);

  res.json({ insights });
}));

/**
 * GET /api/activity/streaks
 * Get publishing streaks per project.
 */
router.get('/streaks', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const streaks = await getPublishingStreaks(userId);

  res.json({ streaks });
}));

export const activityRouter = router;
