/**
 * Goal Tracking Service
 *
 * Updates goal progress based on activity events.
 * Called after relevant activity events (Scrivener imports, sessions, etc.)
 */

import { query } from '../db/connection.js';

export type GoalEventType = 'scrivener_import' | 'session_completed' | 'manual_update';

export interface GoalEventMetadata {
  projectId?: string;
  wordCountDiff?: number;
  sessionCount?: number;
  manualValue?: number;
  goalId?: string;
}

/**
 * Update goal progress based on an activity event.
 *
 * - For word_count goals: increments current_value by word count diff from Scrivener imports
 * - For session_frequency goals: increments current_value by session count
 * - For milestone goals: manual update only (via goalId + manualValue)
 */
export async function updateGoalProgress(
  userId: string,
  eventType: GoalEventType,
  metadata: GoalEventMetadata
): Promise<void> {
  switch (eventType) {
    case 'scrivener_import':
      await handleWordCountUpdate(userId, metadata);
      break;
    case 'session_completed':
      await handleSessionFrequencyUpdate(userId, metadata);
      break;
    case 'manual_update':
      await handleManualUpdate(userId, metadata);
      break;
  }
}

/**
 * Update word_count goals when a Scrivener import adds words.
 */
async function handleWordCountUpdate(
  userId: string,
  metadata: GoalEventMetadata
): Promise<void> {
  const { projectId, wordCountDiff } = metadata;

  if (!projectId || wordCountDiff === undefined || wordCountDiff <= 0) return;

  // Find active word_count goals for this project
  const goalsResult = await query<{ id: string; current_value: number; target_value: number }>(
    `SELECT g.id, g.current_value, g.target_value
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE g.project_id = $1 AND p.user_id = $2
       AND g.goal_type = 'word_count' AND g.status = 'active'`,
    [projectId, userId]
  );

  for (const goal of goalsResult.rows) {
    const newValue = goal.current_value + wordCountDiff;
    const newStatus = newValue >= goal.target_value ? 'completed' : 'active';

    await query(
      `UPDATE goals SET current_value = $1, status = $2 WHERE id = $3`,
      [newValue, newStatus, goal.id]
    );
  }
}

/**
 * Update session_frequency goals when a coaching session is completed.
 */
async function handleSessionFrequencyUpdate(
  userId: string,
  metadata: GoalEventMetadata
): Promise<void> {
  const { projectId } = metadata;
  const increment = metadata.sessionCount || 1;

  // Find active session_frequency goals
  // If projectId is provided, update project-specific goals; otherwise update all
  let goalsResult;

  if (projectId) {
    goalsResult = await query<{ id: string; current_value: number; target_value: number }>(
      `SELECT g.id, g.current_value, g.target_value
       FROM goals g
       JOIN projects p ON p.id = g.project_id
       WHERE g.project_id = $1 AND p.user_id = $2
         AND g.goal_type = 'session_frequency' AND g.status = 'active'`,
      [projectId, userId]
    );
  } else {
    goalsResult = await query<{ id: string; current_value: number; target_value: number }>(
      `SELECT g.id, g.current_value, g.target_value
       FROM goals g
       JOIN projects p ON p.id = g.project_id
       WHERE p.user_id = $1
         AND g.goal_type = 'session_frequency' AND g.status = 'active'`,
      [userId]
    );
  }

  for (const goal of goalsResult.rows) {
    const newValue = goal.current_value + increment;
    const newStatus = newValue >= goal.target_value ? 'completed' : 'active';

    await query(
      `UPDATE goals SET current_value = $1, status = $2 WHERE id = $3`,
      [newValue, newStatus, goal.id]
    );
  }
}

/**
 * Handle manual goal value updates (for milestone goals).
 */
async function handleManualUpdate(
  userId: string,
  metadata: GoalEventMetadata
): Promise<void> {
  const { goalId, manualValue } = metadata;

  if (!goalId || manualValue === undefined) return;

  // Verify ownership
  const goalResult = await query<{ id: string; target_value: number }>(
    `SELECT g.id, g.target_value
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE g.id = $1 AND p.user_id = $2 AND g.status = 'active'`,
    [goalId, userId]
  );

  if (goalResult.rows.length === 0) return;

  const goal = goalResult.rows[0]!;
  const newStatus = manualValue >= goal.target_value ? 'completed' : 'active';

  await query(
    `UPDATE goals SET current_value = $1, status = $2 WHERE id = $3`,
    [manualValue, newStatus, goal.id]
  );
}
