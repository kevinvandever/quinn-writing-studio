/**
 * Activity Service
 *
 * Computes writing activity insights from activity_events table.
 * Provides aggregated metrics for time periods and publishing streaks.
 */

import { query } from '../db/connection.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TimePeriod = 'week' | 'month' | 'quarter';

export interface ActivityInsights {
  period: TimePeriod;
  periodStart: Date;
  periodEnd: Date;
  scrivener: {
    importCount: number;
    totalWordCountDiff: number;
    averageWordCountDiff: number;
  };
  substack: {
    publishCount: number;
    totalWordCount: number;
    averageWordCount: number;
  };
  coaching: {
    sessionCount: number;
    totalDurationMinutes: number;
    averageDurationMinutes: number;
  };
  captures: {
    totalCount: number;
    byProject: Array<{ projectId: string | null; projectName: string | null; count: number }>;
  };
  projectFocus: Array<{ projectId: string; projectName: string; eventCount: number }>;
}

export interface PublishingStreak {
  projectId: string;
  projectName: string;
  currentStreak: number;
  longestStreak: number;
  lastPublishDate: Date | null;
  streakUnit: 'weeks';
}

// ─── Insights ────────────────────────────────────────────────────────────────

/**
 * Get aggregated activity insights for a user over a time period.
 */
export async function getActivityInsights(
  userId: string,
  period: TimePeriod
): Promise<ActivityInsights> {
  const { start, end } = getPeriodRange(period);

  // Scrivener import insights
  const scrivenerResult = await query<{
    import_count: string;
    total_word_diff: string;
  }>(
    `SELECT
       COUNT(*)::text AS import_count,
       COALESCE(SUM((metadata->>'word_count_diff')::int), 0)::text AS total_word_diff
     FROM activity_events
     WHERE user_id = $1
       AND event_type = 'scrivener_import'
       AND created_at >= $2
       AND created_at < $3`,
    [userId, start, end]
  );

  const importCount = parseInt(scrivenerResult.rows[0]?.import_count || '0', 10);
  const totalWordCountDiff = parseInt(scrivenerResult.rows[0]?.total_word_diff || '0', 10);

  // Substack publishing insights
  const substackResult = await query<{
    publish_count: string;
    total_word_count: string;
  }>(
    `SELECT
       COUNT(*)::text AS publish_count,
       COALESCE(SUM((metadata->>'word_count')::int), 0)::text AS total_word_count
     FROM activity_events
     WHERE user_id = $1
       AND event_type = 'substack_publish'
       AND created_at >= $2
       AND created_at < $3`,
    [userId, start, end]
  );

  const publishCount = parseInt(substackResult.rows[0]?.publish_count || '0', 10);
  const totalSubstackWordCount = parseInt(substackResult.rows[0]?.total_word_count || '0', 10);

  // Coaching session insights
  const coachingResult = await query<{
    session_count: string;
    total_duration_minutes: string;
  }>(
    `SELECT
       COUNT(*)::text AS session_count,
       COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::text AS total_duration_minutes
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.user_id = $1
       AND s.started_at >= $2
       AND s.started_at < $3
       AND s.ended_at IS NOT NULL`,
    [userId, start, end]
  );

  const sessionCount = parseInt(coachingResult.rows[0]?.session_count || '0', 10);
  const totalDurationMinutes = parseFloat(coachingResult.rows[0]?.total_duration_minutes || '0');

  // Quick capture volume by project
  const captureResult = await query<{
    project_id: string | null;
    project_name: string | null;
    count: string;
  }>(
    `SELECT
       ae.project_id,
       p.name AS project_name,
       COUNT(*)::text AS count
     FROM activity_events ae
     LEFT JOIN projects p ON p.id = ae.project_id
     WHERE ae.user_id = $1
       AND ae.event_type = 'capture_created'
       AND ae.created_at >= $2
       AND ae.created_at < $3
     GROUP BY ae.project_id, p.name
     ORDER BY count DESC`,
    [userId, start, end]
  );

  const capturesByProject = captureResult.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    count: parseInt(row.count, 10),
  }));

  const totalCaptureCount = capturesByProject.reduce((sum, p) => sum + p.count, 0);

  // Project focus distribution (all event types)
  const focusResult = await query<{
    project_id: string;
    project_name: string;
    event_count: string;
  }>(
    `SELECT
       ae.project_id,
       p.name AS project_name,
       COUNT(*)::text AS event_count
     FROM activity_events ae
     JOIN projects p ON p.id = ae.project_id
     WHERE ae.user_id = $1
       AND ae.project_id IS NOT NULL
       AND ae.created_at >= $2
       AND ae.created_at < $3
     GROUP BY ae.project_id, p.name
     ORDER BY event_count DESC`,
    [userId, start, end]
  );

  const projectFocus = focusResult.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    eventCount: parseInt(row.event_count, 10),
  }));

  return {
    period,
    periodStart: start,
    periodEnd: end,
    scrivener: {
      importCount,
      totalWordCountDiff,
      averageWordCountDiff: importCount > 0 ? Math.round(totalWordCountDiff / importCount) : 0,
    },
    substack: {
      publishCount,
      totalWordCount: totalSubstackWordCount,
      averageWordCount: publishCount > 0 ? Math.round(totalSubstackWordCount / publishCount) : 0,
    },
    coaching: {
      sessionCount,
      totalDurationMinutes: Math.round(totalDurationMinutes),
      averageDurationMinutes: sessionCount > 0 ? Math.round(totalDurationMinutes / sessionCount) : 0,
    },
    captures: {
      totalCount: totalCaptureCount,
      byProject: capturesByProject,
    },
    projectFocus,
  };
}

// ─── Publishing Streaks ──────────────────────────────────────────────────────

/**
 * Get publishing streaks per project.
 * A streak is measured in consecutive weeks with at least one publish event.
 */
export async function getPublishingStreaks(userId: string): Promise<PublishingStreak[]> {
  // Get all projects with substack publish events
  const projectsResult = await query<{
    project_id: string;
    project_name: string;
  }>(
    `SELECT DISTINCT ae.project_id, p.name AS project_name
     FROM activity_events ae
     JOIN projects p ON p.id = ae.project_id
     WHERE ae.user_id = $1
       AND ae.event_type = 'substack_publish'
       AND ae.project_id IS NOT NULL`,
    [userId]
  );

  const streaks: PublishingStreak[] = [];

  for (const project of projectsResult.rows) {
    // Get all publish dates for this project, ordered
    const publishDates = await query<{ publish_week: string; last_date: Date }>(
      `SELECT
         DATE_TRUNC('week', created_at)::text AS publish_week,
         MAX(created_at) AS last_date
       FROM activity_events
       WHERE user_id = $1
         AND project_id = $2
         AND event_type = 'substack_publish'
       GROUP BY DATE_TRUNC('week', created_at)
       ORDER BY publish_week DESC`,
      [userId, project.project_id]
    );

    if (publishDates.rows.length === 0) {
      streaks.push({
        projectId: project.project_id,
        projectName: project.project_name,
        currentStreak: 0,
        longestStreak: 0,
        lastPublishDate: null,
        streakUnit: 'weeks',
      });
      continue;
    }

    const lastPublishDate = publishDates.rows[0]!.last_date;
    const weeks = publishDates.rows.map((r) => new Date(r.publish_week).getTime());

    // Calculate current streak (consecutive weeks from most recent)
    let currentStreak = 1;
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const currentWeekStart = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
    ).getTime();

    // Check if the most recent publish week is current or last week
    const mostRecentWeek = weeks[0]!;
    if (currentWeekStart - mostRecentWeek > oneWeekMs) {
      // Streak is broken (more than 1 week gap from current)
      currentStreak = 0;
    } else {
      for (let i = 1; i < weeks.length; i++) {
        const gap = weeks[i - 1]! - weeks[i]!;
        if (Math.abs(gap - oneWeekMs) < oneWeekMs * 0.5) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    // Calculate longest streak
    let longestStreak = 1;
    let tempStreak = 1;
    for (let i = 1; i < weeks.length; i++) {
      const gap = weeks[i - 1]! - weeks[i]!;
      if (Math.abs(gap - oneWeekMs) < oneWeekMs * 0.5) {
        tempStreak++;
        longestStreak = Math.max(longestStreak, tempStreak);
      } else {
        tempStreak = 1;
      }
    }

    streaks.push({
      projectId: project.project_id,
      projectName: project.project_name,
      currentStreak,
      longestStreak,
      lastPublishDate,
      streakUnit: 'weeks',
    });
  }

  return streaks;
}

// ─── Activity Summary for Coaching ──────────────────────────────────────────

/**
 * Get a recent activity summary for use in coaching system prompts.
 * Returns a human-readable summary of the user's recent writing activity.
 */
export async function getRecentActivitySummary(
  userId: string,
  projectId: string
): Promise<string | null> {
  const insights = await getActivityInsights(userId, 'week');

  const parts: string[] = [];

  if (insights.scrivener.importCount > 0) {
    const direction = insights.scrivener.totalWordCountDiff >= 0 ? 'added' : 'removed';
    parts.push(
      `${insights.scrivener.importCount} Scrivener import${insights.scrivener.importCount > 1 ? 's' : ''} this week (${Math.abs(insights.scrivener.totalWordCountDiff)} words ${direction})`
    );
  }

  if (insights.substack.publishCount > 0) {
    parts.push(
      `${insights.substack.publishCount} Substack post${insights.substack.publishCount > 1 ? 's' : ''} published (${insights.substack.totalWordCount} total words)`
    );
  }

  if (insights.coaching.sessionCount > 0) {
    parts.push(
      `${insights.coaching.sessionCount} coaching session${insights.coaching.sessionCount > 1 ? 's' : ''} (${insights.coaching.totalDurationMinutes} min total)`
    );
  }

  if (insights.captures.totalCount > 0) {
    parts.push(
      `${insights.captures.totalCount} quick capture${insights.captures.totalCount > 1 ? 's' : ''}`
    );
  }

  if (parts.length === 0) {
    return null;
  }

  // Get publishing streaks for this project
  const streaks = await getPublishingStreaks(userId);
  const projectStreak = streaks.find((s) => s.projectId === projectId);

  let streakNote = '';
  if (projectStreak && projectStreak.currentStreak > 1) {
    streakNote = ` Publishing streak: ${projectStreak.currentStreak} consecutive weeks.`;
  }

  return `RECENT ACTIVITY (this week): ${parts.join('; ')}.${streakNote}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the start and end dates for a time period.
 */
function getPeriodRange(period: TimePeriod): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  let start: Date;

  switch (period) {
    case 'week':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      break;
    case 'month':
      start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      break;
    case 'quarter':
      start = new Date(now);
      start.setMonth(start.getMonth() - 3);
      break;
    default:
      start = new Date(now);
      start.setDate(start.getDate() - 7);
  }

  return { start, end };
}
