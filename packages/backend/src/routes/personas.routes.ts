import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { personaConfigSchema } from '../schemas/persona.schema.js';

const router = Router();

// Apply auth middleware to all persona routes
router.use(requireAuth);

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
