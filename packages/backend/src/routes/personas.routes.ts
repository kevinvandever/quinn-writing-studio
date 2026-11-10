import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getClient, query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import {
  MAX_EXAMPLE_REPLY_CHARS,
  MAX_EXAMPLE_WRITER_CHARS,
  MAX_VOICE_EXAMPLES,
  personaConfigSchema,
  type VoiceExample,
} from '../schemas/persona.schema.js';
import { formatWriterShortDate } from '../utils/time.js';

const router = Router();

// Apply auth middleware to all persona routes
router.use(requireAuth);

// ─── Voice examples ──────────────────────────────────────────────────────────
// Real exchanges kept in the active persona (config.voice.example_exchanges),
// shown to Quinn as examples of how she should sound. Defined before the
// /:id routes.

const keepExampleSchema = z.object({
  sessionId: z.string().uuid(),
  /** The reply's text: a reply streamed moments ago has no id in the browser. */
  content: z.string().min(1).max(200_000),
});

/** Change the active persona's voice examples in one locked read-modify-write. */
async function updateVoiceExamples(
  userId: string,
  change: (examples: VoiceExample[]) => VoiceExample[]
): Promise<VoiceExample[]> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const row = (
      await client.query<{ id: string; examples: unknown }>(
        `SELECT id, config->'voice'->'example_exchanges' AS examples
         FROM persona_configurations
         WHERE user_id = $1 AND is_active = true
         ORDER BY updated_at DESC
         LIMIT 1
         FOR UPDATE`,
        [userId]
      )
    ).rows[0];
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No active persona configuration');
    const next = change(Array.isArray(row.examples) ? (row.examples as VoiceExample[]) : []);
    await client.query(
      `UPDATE persona_configurations
       SET config = jsonb_set(
             jsonb_set(config, '{voice}', COALESCE(config->'voice', '{}'::jsonb)),
             '{voice,example_exchanges}', $2::jsonb),
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, JSON.stringify(next)]
    );
    await client.query('COMMIT');
    return next;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/personas/active/examples
 * Keep one of Quinn's replies, with the writer's message before it, as an
 * example of her voice. Body: { sessionId, content }.
 */
router.post('/active/examples', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { sessionId, content } = keepExampleSchema.parse(req.body);

  // The chat can still show the end of an earlier session above the current
  // one, so the reply is looked up among all the writer's, this session first.
  const reply = (
    await query<{ session_id: string; content: string; created_at: Date }>(
      `SELECT m.session_id, m.content, m.created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE p.user_id = $2 AND m.role = 'assistant'
         AND btrim(m.content, E' \\n\\r\\t') = btrim($3, E' \\n\\r\\t')
       ORDER BY (m.session_id = $1) DESC, m.created_at DESC
       LIMIT 1`,
      [sessionId, userId, content]
    )
  ).rows[0];
  if (!reply) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, "That reply isn't saved yet. Try again in a moment.");
  }
  const quinn = reply.content.trim();
  if (quinn.length > MAX_EXAMPLE_REPLY_CHARS) {
    const words = quinn.split(/\s+/).length;
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Examples work best when they're short. This reply is about ${words} words; pick one under 400.`
    );
  }
  const before = (
    await query<{ content: string }>(
      `SELECT content FROM messages
       WHERE session_id = $1 AND role = 'user' AND created_at < $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [reply.session_id, reply.created_at]
    )
  ).rows[0];
  const said = (before?.content ?? '').trim();
  const writer = said.length > MAX_EXAMPLE_WRITER_CHARS ? `${said.slice(0, MAX_EXAMPLE_WRITER_CHARS).trimEnd()} […]` : said;
  const example: VoiceExample = { writer, quinn, from: formatWriterShortDate(reply.created_at) };

  const examples = await updateVoiceExamples(userId, (list) => {
    if (list.some((e) => e.quinn.trim() === quinn)) {
      throw new AppError(409, ErrorCodes.CONFLICT, 'That reply is already one of the examples.');
    }
    if (list.length >= MAX_VOICE_EXAMPLES) {
      throw new AppError(
        409,
        ErrorCodes.CONFLICT,
        `Quinn already has ${MAX_VOICE_EXAMPLES} voice examples. Remove one in Settings first.`
      );
    }
    return [...list, example];
  });
  res.status(201).json({ examples });
}));

/**
 * DELETE /api/personas/active/examples/:index
 * Remove a voice example by its position in the list.
 */
router.delete('/active/examples/:index', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Give the example\'s position as a whole number.');
  }
  const examples = await updateVoiceExamples(userId, (list) => {
    if (index >= list.length) throw new AppError(404, ErrorCodes.NOT_FOUND, 'There is no example at that position.');
    return list.filter((_, i) => i !== index);
  });
  res.json({ examples });
}));

/**
 * GET /api/personas
 * List all persona configurations for the authenticated user.
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, is_active, config, created_at, updated_at
     FROM persona_configurations
     WHERE user_id = $1
     ORDER BY is_active DESC, updated_at DESC`,
    [userId]
  );

  res.json({ personas: result.rows });
}));

/**
 * GET /api/personas/:id
 * Get a specific persona configuration (verify ownership).
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const personaId = req.params.id;

  const result = await query<{
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, is_active, config, created_at, updated_at
     FROM persona_configurations
     WHERE id = $1 AND user_id = $2`,
    [personaId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Persona configuration not found');
  }

  res.json({ persona: result.rows[0] });
}));

/**
 * POST /api/personas
 * Create a new persona configuration.
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const config = personaConfigSchema.parse(req.body);

  const result = await query<{
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO persona_configurations (user_id, name, is_active, config)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, is_active, config, created_at, updated_at`,
    [userId, config.name, false, JSON.stringify(config)]
  );

  res.status(201).json({ persona: result.rows[0] });
}));

/**
 * PUT /api/personas/:id
 * Update an existing persona configuration (validate against schema).
 */
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const personaId = req.params.id;
  const config = personaConfigSchema.parse(req.body);

  const result = await query<{
    id: string;
    name: string;
    is_active: boolean;
    config: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `UPDATE persona_configurations
     SET name = $1, config = $2, updated_at = NOW()
     WHERE id = $3 AND user_id = $4
     RETURNING id, name, is_active, config, created_at, updated_at`,
    [config.name, JSON.stringify(config), personaId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Persona configuration not found');
  }

  res.json({ persona: result.rows[0] });
}));

/**
 * POST /api/personas/:id/validate
 * Validate a persona configuration against the schema without saving.
 */
router.post('/:id/validate', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const personaId = req.params.id;

  // Verify the persona exists and belongs to the user
  const existing = await query(
    `SELECT id FROM persona_configurations WHERE id = $1 AND user_id = $2`,
    [personaId, userId]
  );

  if (existing.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Persona configuration not found');
  }

  const parseResult = personaConfigSchema.safeParse(req.body);

  if (!parseResult.success) {
    const fieldErrors = parseResult.error.errors.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    res.json({ valid: false, errors: fieldErrors });
    return;
  }

  res.json({ valid: true, errors: [] });
}));

export const personasRouter = router;
