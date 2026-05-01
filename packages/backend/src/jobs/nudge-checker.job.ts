/**
 * Nudge Checker Job
 *
 * Hourly job that checks for conditions requiring nudges:
 * - Quiet period thresholds (gentle/warm/direct escalation)
 * - Goal progress behind threshold
 * - Deadline proximity (14 days)
 * - Stale corpus
 * - Goal completion celebrations
 */

import { query } from '../db/connection.js';
import {
  generateAndStoreNudge,
  type NudgeType,
  type NudgeUrgency,
} from '../services/notification.service.js';

interface QuietPeriodThresholds {
  gentle: number;
  warm: number;
  direct: number;
}

const DEFAULT_THRESHOLDS: QuietPeriodThresholds = {
  gentle: 3,
  warm: 7,
  direct: 14,
};

const DEFAULT_STALE_CORPUS_DAYS = 30;

/**
 * Run the nudge checker for a specific user.
 */
export async function runNudgeChecker(userId: string): Promise<void> {
  console.log(`[NudgeChecker] Running nudge checks for user ${userId}`);

  // Check if user is on vacation
  const isOnVacation = await checkVacationMode(userId);
  if (isOnVacation) {
    console.log(`[NudgeChecker] User ${userId} is on vacation, skipping nudges`);
    return;
  }

  // Load user settings for thresholds
  const settings = await loadUserSettings(userId);
  const thresholds = settings.quietPeriodThresholds || DEFAULT_THRESHOLDS;
  const staleCorpusDays = settings.staleCorpusThresholdDays || DEFAULT_STALE_CORPUS_DAYS;

  // Run all checks
  await checkQuietPeriod(userId, thresholds);
  await checkGoalsBehind(userId);
  await checkDeadlineProximity(userId);
  await checkStaleCorpus(userId, staleCorpusDays);
  await checkGoalCompletions(userId);

  console.log(`[NudgeChecker] Completed nudge checks for user ${userId}`);
}

/**
 * Check if user is currently on vacation.
 */
async function checkVacationMode(userId: string): Promise<boolean> {
  const result = await query<{ vacation_start: Date | null; vacation_end: Date | null }>(
    `SELECT vacation_start, vacation_end FROM settings WHERE user_id = $1`,
    [userId]
  );

  const settings = result.rows[0];
  if (!settings?.vacation_start || !settings?.vacation_end) return false;

  const now = new Date();
  return now >= settings.vacation_start && now <= settings.vacation_end;
}

/**
 * Load user settings for nudge thresholds.
 */
async function loadUserSettings(userId: string): Promise<{
  quietPeriodThresholds: QuietPeriodThresholds | null;
  staleCorpusThresholdDays: number | null;
}> {
  const result = await query<{
    quiet_period_thresholds: QuietPeriodThresholds | null;
    stale_corpus_threshold_days: number | null;
  }>(
    `SELECT quiet_period_thresholds, stale_corpus_threshold_days FROM settings WHERE user_id = $1`,
    [userId]
  );

  const row = result.rows[0];
  return {
    quietPeriodThresholds: row?.quiet_period_thresholds || null,
    staleCorpusThresholdDays: row?.stale_corpus_threshold_days || null,
  };
}

/**
 * Check for quiet period and escalate nudge urgency.
 */
async function checkQuietPeriod(
  userId: string,
  thresholds: QuietPeriodThresholds
): Promise<void> {
  // Find the most recent activity event
  const result = await query<{ created_at: Date }>(
    `SELECT created_at FROM activity_events
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) return;

  const lastActivity = result.rows[0]!.created_at;
  const daysSinceActivity = Math.floor(
    (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
  );

  // Determine which threshold we've crossed
  let nudgeType: NudgeType | null = null;
  let urgency: NudgeUrgency = 'low';

  if (daysSinceActivity >= thresholds.direct) {
    nudgeType = 'quiet_period_direct';
    urgency = 'high';
  } else if (daysSinceActivity >= thresholds.warm) {
    nudgeType = 'quiet_period_warm';
    urgency = 'medium';
  } else if (daysSinceActivity >= thresholds.gentle) {
    nudgeType = 'quiet_period_gentle';
    urgency = 'low';
  }

  if (!nudgeType) return;

  // Check if we already sent this type of nudge recently (within 24 hours)
  const recentNudge = await query<{ id: string }>(
    `SELECT id FROM nudges
     WHERE user_id = $1 AND nudge_type = $2
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [userId, nudgeType]
  );

  if (recentNudge.rows.length > 0) return;

  await generateAndStoreNudge({
    nudgeType,
    urgency,
    userId,
    context: { daysSinceActivity, lastActivity },
  });
}

/**
 * Check for goals that are behind their threshold.
 */
async function checkGoalsBehind(userId: string): Promise<void> {
  const result = await query<{
    id: string;
    title: string;
    current_value: number;
    target_value: number;
    behind_threshold: number;
    due_date: Date | null;
  }>(
    `SELECT g.id, g.title, g.current_value, g.target_value, g.behind_threshold, g.due_date
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE p.user_id = $1 AND g.status = 'active'`,
    [userId]
  );

  for (const goal of result.rows) {
    const progress = goal.target_value > 0 ? goal.current_value / goal.target_value : 0;

    if (progress < goal.behind_threshold) {
      // Check if we already nudged about this goal recently
      const recentNudge = await query<{ id: string }>(
        `SELECT id FROM nudges
         WHERE user_id = $1 AND nudge_type = 'goal_behind' AND reference_id = $2
           AND created_at > NOW() - INTERVAL '48 hours'`,
        [userId, goal.id]
      );

      if (recentNudge.rows.length > 0) continue;

      await generateAndStoreNudge({
        nudgeType: 'goal_behind',
        urgency: 'medium',
        userId,
        referenceId: goal.id,
        context: {
          goalTitle: goal.title,
          currentProgress: Math.round(progress * 100),
          targetValue: goal.target_value,
          currentValue: goal.current_value,
        },
      });
    }
  }
}

/**
 * Check for deadlines approaching within 14 days.
 */
async function checkDeadlineProximity(userId: string): Promise<void> {
  const result = await query<{
    id: string;
    title: string;
    due_date: Date;
    current_value: number;
    target_value: number;
  }>(
    `SELECT g.id, g.title, g.due_date, g.current_value, g.target_value
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE p.user_id = $1 AND g.status = 'active'
       AND g.due_date IS NOT NULL
       AND g.due_date <= NOW() + INTERVAL '14 days'
       AND g.due_date > NOW()`,
    [userId]
  );

  for (const goal of result.rows) {
    const daysUntilDue = Math.ceil(
      (new Date(goal.due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    // Check if we already nudged about this deadline recently
    const recentNudge = await query<{ id: string }>(
      `SELECT id FROM nudges
       WHERE user_id = $1 AND nudge_type = 'deadline_approaching' AND reference_id = $2
         AND created_at > NOW() - INTERVAL '48 hours'`,
      [userId, goal.id]
    );

    if (recentNudge.rows.length > 0) continue;

    const urgency: NudgeUrgency = daysUntilDue <= 3 ? 'high' : daysUntilDue <= 7 ? 'medium' : 'low';

    await generateAndStoreNudge({
      nudgeType: 'deadline_approaching',
      urgency,
      userId,
      referenceId: goal.id,
      context: {
        goalTitle: goal.title,
        daysUntilDue,
        dueDate: goal.due_date,
        currentValue: goal.current_value,
        targetValue: goal.target_value,
      },
    });
  }
}

/**
 * Check for stale corpus (no imports in configured threshold days).
 */
async function checkStaleCorpus(userId: string, thresholdDays: number): Promise<void> {
  const result = await query<{ latest_import: Date }>(
    `SELECT MAX(si.imported_at) as latest_import
     FROM scrivener_imports si
     JOIN projects p ON p.id = si.project_id
     WHERE p.user_id = $1`,
    [userId]
  );

  const latestImport = result.rows[0]?.latest_import;
  if (!latestImport) return;

  const daysSinceImport = Math.floor(
    (Date.now() - new Date(latestImport).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceImport < thresholdDays) return;

  // Check if we already sent a stale corpus nudge recently
  const recentNudge = await query<{ id: string }>(
    `SELECT id FROM nudges
     WHERE user_id = $1 AND nudge_type = 'stale_corpus'
       AND created_at > NOW() - INTERVAL '7 days'`,
    [userId]
  );

  if (recentNudge.rows.length > 0) return;

  await generateAndStoreNudge({
    nudgeType: 'stale_corpus',
    urgency: 'low',
    userId,
    context: { daysSinceImport, lastImportDate: latestImport },
  });
}

/**
 * Check for recently completed goals to celebrate.
 */
async function checkGoalCompletions(userId: string): Promise<void> {
  // Find goals that were completed in the last hour (since this runs hourly)
  // and haven't been celebrated yet
  const result = await query<{ id: string; title: string }>(
    `SELECT g.id, g.title
     FROM goals g
     JOIN projects p ON p.id = g.project_id
     WHERE p.user_id = $1 AND g.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM nudges n
         WHERE n.user_id = $1 AND n.nudge_type = 'goal_celebration' AND n.reference_id = g.id
       )`,
    [userId]
  );

  for (const goal of result.rows) {
    await generateAndStoreNudge({
      nudgeType: 'goal_celebration',
      urgency: 'low',
      userId,
      referenceId: goal.id,
      context: { goalTitle: goal.title },
    });
  }
}
