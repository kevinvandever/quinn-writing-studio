/**
 * Settings Routes
 *
 * Provides user settings management including API key storage,
 * model routing preferences, and notification configuration.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { query } from '../db/connection.js';
import { encrypt, decrypt } from '../utils/encryption.js';

const router = Router();

// Apply auth middleware to all settings routes
router.use(requireAuth);

/**
 * GET /api/settings
 * Get all settings for the current user.
 * API key is returned masked (only last 4 chars visible).
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{
    id: string;
    user_id: string;
    anthropic_api_key: string | null;
    model_routing_preference: string;
    quiet_period_thresholds: Record<string, number> | null;
    stale_corpus_threshold_days: number | null;
    email_notifications_enabled: boolean;
    notification_email: string | null;
    vacation_start: Date | null;
    vacation_end: Date | null;
    intelligence_schedules: Record<string, string> | null;
  }>(
    `SELECT * FROM settings WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    // Return defaults if no settings exist
    res.json({
      settings: {
        anthropic_api_key_set: false,
        anthropic_api_key_masked: null,
        model_routing_preference: 'auto',
        quiet_period_thresholds: { gentle: 3, warm: 7, direct: 14 },
        stale_corpus_threshold_days: 30,
        email_notifications_enabled: false,
        notification_email: null,
        vacation_start: null,
        vacation_end: null,
        intelligence_schedules: null,
      },
    });
    return;
  }

  const settings = result.rows[0]!;

  // Mask the API key
  let apiKeyMasked: string | null = null;
  if (settings.anthropic_api_key) {
    try {
      const decrypted = decrypt(settings.anthropic_api_key);
      apiKeyMasked = '••••' + decrypted.slice(-4);
    } catch {
      apiKeyMasked = '••••(error)';
    }
  }

  res.json({
    settings: {
      anthropic_api_key_set: !!settings.anthropic_api_key,
      anthropic_api_key_masked: apiKeyMasked,
      model_routing_preference: settings.model_routing_preference || 'auto',
      quiet_period_thresholds: settings.quiet_period_thresholds || { gentle: 3, warm: 7, direct: 14 },
      stale_corpus_threshold_days: settings.stale_corpus_threshold_days || 30,
      email_notifications_enabled: settings.email_notifications_enabled || false,
      notification_email: settings.notification_email,
      vacation_start: settings.vacation_start,
      vacation_end: settings.vacation_end,
      intelligence_schedules: settings.intelligence_schedules,
    },
  });
}));

/**
 * PUT /api/settings
 * Update settings for the current user.
 * API key is encrypted before storage.
 */
router.put('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const {
    anthropic_api_key,
    model_routing_preference,
    quiet_period_thresholds,
    stale_corpus_threshold_days,
    email_notifications_enabled,
    notification_email,
    intelligence_schedules,
  } = req.body;

  // Validate model_routing_preference
  if (model_routing_preference) {
    const validPreferences = ['auto', 'always_sonnet', 'always_opus'];
    if (!validPreferences.includes(model_routing_preference)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `model_routing_preference must be one of: ${validPreferences.join(', ')}`
      );
    }
  }

  // Build dynamic upsert
  const updates: string[] = [];
  const values: unknown[] = [userId];
  let paramIndex = 2;

  if (anthropic_api_key !== undefined) {
    const encrypted = anthropic_api_key ? encrypt(anthropic_api_key) : null;
    updates.push(`anthropic_api_key = $${paramIndex++}`);
    values.push(encrypted);
  }
  if (model_routing_preference !== undefined) {
    updates.push(`model_routing_preference = $${paramIndex++}`);
    values.push(model_routing_preference);
  }
  if (quiet_period_thresholds !== undefined) {
    updates.push(`quiet_period_thresholds = $${paramIndex++}`);
    values.push(JSON.stringify(quiet_period_thresholds));
  }
  if (stale_corpus_threshold_days !== undefined) {
    updates.push(`stale_corpus_threshold_days = $${paramIndex++}`);
    values.push(stale_corpus_threshold_days);
  }
  if (email_notifications_enabled !== undefined) {
    updates.push(`email_notifications_enabled = $${paramIndex++}`);
    values.push(email_notifications_enabled);
  }
  if (notification_email !== undefined) {
    updates.push(`notification_email = $${paramIndex++}`);
    values.push(notification_email);
  }
  if (intelligence_schedules !== undefined) {
    updates.push(`intelligence_schedules = $${paramIndex++}`);
    values.push(JSON.stringify(intelligence_schedules));
  }

  if (updates.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'No fields to update');
  }

  // Upsert settings
  await query(
    `INSERT INTO settings (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
    values
  );

  res.json({ message: 'Settings updated successfully' });
}));

export const settingsRouter = router;
