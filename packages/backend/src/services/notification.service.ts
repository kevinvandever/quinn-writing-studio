/**
 * Notification Service
 *
 * Generates nudge text via Claude API with Quinn's persona,
 * stores in nudges table, and optionally sends via email.
 */

import { query } from '../db/connection.js';
import { sendMessage, type ModelSelection } from './claude-api.service.js';

export type NudgeType =
  | 'quiet_period_gentle'
  | 'quiet_period_warm'
  | 'quiet_period_direct'
  | 'goal_behind'
  | 'deadline_approaching'
  | 'stale_corpus'
  | 'goal_celebration';

export type NudgeUrgency = 'low' | 'medium' | 'high';

export interface NudgeContext {
  nudgeType: NudgeType;
  urgency: NudgeUrgency;
  userId: string;
  referenceId?: string;
  context: Record<string, unknown>;
}

const NUDGE_PROMPTS: Record<NudgeType, string> = {
  quiet_period_gentle:
    'The writer has been quiet for a few days. Generate a gentle, warm check-in message. Be curious about what they might be working on or thinking about. Keep it brief (1-2 sentences).',
  quiet_period_warm:
    'The writer has been away for about a week. Generate a warm, encouraging message that acknowledges life gets busy while gently reminding them of their creative work. Keep it to 2-3 sentences.',
  quiet_period_direct:
    'The writer has been away for two weeks or more. Generate a direct but compassionate message. Acknowledge the gap without guilt-tripping. Offer a small, achievable re-entry point. Keep it to 2-3 sentences.',
  goal_behind:
    'The writer is falling behind on a goal. Generate an encouraging message that acknowledges the challenge while offering perspective. Mention the specific goal context provided. Keep it to 2-3 sentences.',
  deadline_approaching:
    'A deadline is approaching within 14 days. Generate a helpful reminder that creates urgency without anxiety. Mention the specific deadline context. Keep it to 2-3 sentences.',
  stale_corpus:
    'The writer\'s corpus hasn\'t been updated in a while. Generate a gentle reminder to import their latest work so coaching can be more relevant. Keep it to 1-2 sentences.',
  goal_celebration:
    'The writer has completed a goal! Generate a warm celebration message. Be genuinely enthusiastic but not over-the-top. Keep it to 2-3 sentences.',
};

/**
 * Generate a nudge message using Claude with Quinn's persona and store it.
 */
export async function generateAndStoreNudge(nudgeContext: NudgeContext): Promise<string> {
  const { nudgeType, urgency, userId, referenceId, context } = nudgeContext;

  // Load Quinn's persona for the nudge
  const personaResult = await query<{ config: Record<string, unknown> }>(
    `SELECT config FROM persona_configurations WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId]
  );

  const personaConfig = personaResult.rows[0]?.config || {};
  const personaName = (personaConfig as Record<string, unknown>)['name'] || 'Quinn';

  // Build the system prompt for nudge generation
  const systemPrompt = `You are ${personaName}, a writing coach and creative partner. You are generating a brief nudge/notification message for your writer. Your tone should match the urgency level: ${urgency}. Be warm, supportive, and authentic. Never guilt-trip or shame.

Context about the situation: ${JSON.stringify(context)}`;

  const taskPrompt = NUDGE_PROMPTS[nudgeType];

  // Generate nudge text via Claude (always use Sonnet for nudges — quick, efficient)
  const model: ModelSelection = 'sonnet';

  const response = await sendMessage({
    systemPrompt,
    messages: [{ role: 'user', content: taskPrompt }],
    model,
  });

  const nudgeText = response.content;

  // Store the nudge in the database
  await query(
    `INSERT INTO nudges (user_id, nudge_type, urgency, content, reference_id, delivered_via)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      nudgeType,
      urgency,
      nudgeText,
      referenceId || null,
      ['in_app'],
    ]
  );

  // Optionally send via email (stub — just log it)
  await sendEmailNotification(userId, nudgeText, nudgeType);

  return nudgeText;
}

/**
 * Stub for email notification sending.
 * In production, this would integrate with SendGrid/Resend.
 */
async function sendEmailNotification(
  userId: string,
  content: string,
  nudgeType: NudgeType
): Promise<void> {
  // Check if user has email notifications enabled
  const settingsResult = await query<{
    email_notifications_enabled: boolean;
    notification_email: string | null;
  }>(
    `SELECT email_notifications_enabled, notification_email FROM settings WHERE user_id = $1`,
    [userId]
  );

  const settings = settingsResult.rows[0];
  if (!settings?.email_notifications_enabled || !settings.notification_email) {
    return;
  }

  // Stub: Log the email that would be sent
  console.log(`[NotificationService] Would send email to ${settings.notification_email}:`);
  console.log(`  Type: ${nudgeType}`);
  console.log(`  Content: ${content}`);
}

/**
 * Get pending (unacknowledged) nudges for a user.
 */
export async function getPendingNudges(userId: string) {
  const result = await query<{
    id: string;
    nudge_type: string;
    urgency: string;
    content: string;
    reference_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, nudge_type, urgency, content, reference_id, created_at
     FROM nudges
     WHERE user_id = $1 AND acknowledged_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows;
}

/**
 * Acknowledge (dismiss) a nudge.
 */
export async function acknowledgeNudge(nudgeId: string, userId: string): Promise<boolean> {
  const result = await query(
    `UPDATE nudges SET acknowledged_at = NOW()
     WHERE id = $1 AND user_id = $2 AND acknowledged_at IS NULL`,
    [nudgeId, userId]
  );

  return (result.rowCount ?? 0) > 0;
}
