/**
 * Goals Routes
 *
 * Provides goal tracking and accountability endpoints.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { query } from '../db/connection.js';

const router = Router();

// Apply auth middleware to all goals routes
router.use(requireAuth);

/**
 * GET /api/projects/:id/goals
 * List all goals for a specific project.
 */
router.get('/projects/:id/goals', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  const result = await query<{
    id: string;
    project_id: string;
    goal_type: string;
    title: string;
    target_value: number;
    target_unit: string;
    period: string;
    current_value: number;
    status: string;
    behind_threshold: number;
    created_at: Date;
    due_date: Date | null;
  }>(
    `SELECT id, project_id, goal_type, title, target_value, target_unit, period,
            current_value, status, behind_threshold, created_at, due_date
     FROM goals
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );

  res.json({ goals: result.rows });
});

/**
 * POST /api/projects/:id/goals
 * Create a new goal for a project.
 */
router.post('/projects/:id/goals', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;
  const { goal_type, title, target_value, target_unit, period, behind_threshold, due_date } = req.body;

  if (!goal_type || !title || target_value === undefined) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'goal_type, title, and target_value are required');
  }

  // Validate goal_type
  const validGoalTypes = ['word_count', 'session_frequency', 'milestone'];
  if (!validGoalTypes.includes(goal_type)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `goal_type must be one of: ${validGoalTypes.join(', ')}`);
  }

  // Validate period if provided
  const validPeriods = ['daily', 'weekly', 'monthly', 'total'];
  if (period && !validPeriods.includes(period)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `period must be one of: ${validPeriods.join(', ')}`);
  }

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  const result = await query<{
    id: string;
    project_id: string;
    goal_type: string;
    title: string;
    target_value: number;
    target_unit: string;
    period: string;
    current_value: number;
    status: string;
    behind_threshold: number;
    created_at: Date;
    due_date: Date | null;
  }>(
    `INSERT INTO goals (project_id, goal_type, title, target_value, target_unit, period, behind_threshold, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, project_id, goal_type, title, target_value, target_unit, period,
               current_value, status, behind_threshold, created_at, due_date`,
    [
      projectId,
      goal_type,
      title,
      target_value,
      target_unit || 'words',
      period || 'total',
      behind_threshold || 0.8,
      due_date || null,
    ]
  );

  res.status(201).json({ goal: result.rows[0] });
});

/**
 * PUT /api/goals/:id
 * Update an existing goal.
 */
router.put('/goals/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const goalId = req.params.id;
  const { title, target_value, current_value, status, behind_threshold, due_date } = req.body;

  // Verify goal ownership via project
  const goalResult = await query<{ id: string; project_id: string }>(
    `SELECT g.id, g.project_id FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE g.id = $1 AND p.user_id = $2`,
    [goalId, userId]
  );

  if (goalResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Goal not found');
  }

  // Build dynamic update query
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (title !== undefined) {
    updates.push(`title = $${paramIndex++}`);
    values.push(title);
  }
  if (target_value !== undefined) {
    updates.push(`target_value = $${paramIndex++}`);
    values.push(target_value);
  }
  if (current_value !== undefined) {
    updates.push(`current_value = $${paramIndex++}`);
    values.push(current_value);
  }
  if (status !== undefined) {
    const validStatuses = ['active', 'completed', 'paused', 'abandoned'];
    if (!validStatuses.includes(status)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `status must be one of: ${validStatuses.join(', ')}`);
    }
    updates.push(`status = $${paramIndex++}`);
    values.push(status);
  }
  if (behind_threshold !== undefined) {
    updates.push(`behind_threshold = $${paramIndex++}`);
    values.push(behind_threshold);
  }
  if (due_date !== undefined) {
    updates.push(`due_date = $${paramIndex++}`);
    values.push(due_date);
  }

  if (updates.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'No fields to update');
  }

  values.push(goalId);

  const result = await query<{
    id: string;
    project_id: string;
    goal_type: string;
    title: string;
    target_value: number;
    target_unit: string;
    period: string;
    current_value: number;
    status: string;
    behind_threshold: number;
    created_at: Date;
    due_date: Date | null;
  }>(
    `UPDATE goals SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING id, project_id, goal_type, title, target_value, target_unit, period,
               current_value, status, behind_threshold, created_at, due_date`,
    values
  );

  res.json({ goal: result.rows[0] });
});

/**
 * GET /api/goals/dashboard
 * Unified dashboard showing all goals across all projects.
 */
router.get('/goals/dashboard', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{
    id: string;
    project_id: string;
    project_name: string;
    goal_type: string;
    title: string;
    target_value: number;
    target_unit: string;
    period: string;
    current_value: number;
    status: string;
    behind_threshold: number;
    created_at: Date;
    due_date: Date | null;
  }>(
    `SELECT g.id, g.project_id, p.name as project_name, g.goal_type, g.title,
            g.target_value, g.target_unit, g.period, g.current_value, g.status,
            g.behind_threshold, g.created_at, g.due_date
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE p.user_id = $1 AND g.status = 'active'
     ORDER BY g.due_date ASC NULLS LAST, g.created_at DESC`,
    [userId]
  );

  // Compute summary stats
  const totalGoals = result.rows.length;
  const onTrack = result.rows.filter(
    (g) => g.current_value / g.target_value >= g.behind_threshold
  ).length;
  const behindSchedule = totalGoals - onTrack;

  res.json({
    goals: result.rows,
    summary: {
      totalGoals,
      onTrack,
      behindSchedule,
    },
  });
});

export const goalsRouter = router;
