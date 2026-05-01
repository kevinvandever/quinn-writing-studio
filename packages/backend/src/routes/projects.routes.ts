import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';

const router = Router();

// Apply auth middleware to all project routes
router.use(requireAuth);

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(255),
  description: z.string().optional(),
  central_question: z.string().optional(),
  project_type: z.enum(['essay_collection', 'substack', 'promptly', 'custom']),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  central_question: z.string().optional(),
  project_type: z.enum(['essay_collection', 'substack', 'promptly', 'custom']).optional(),
});

/**
 * GET /api/projects
 * List all projects for the authenticated user.
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    central_question: string | null;
    project_type: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, description, central_question, project_type, created_at, updated_at
     FROM projects
     WHERE user_id = $1 AND archived_at IS NULL
     ORDER BY updated_at DESC`,
    [userId]
  );

  res.json({ projects: result.rows });
});

/**
 * POST /api/projects
 * Create a new project.
 */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const data = createProjectSchema.parse(req.body);

  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    central_question: string | null;
    project_type: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO projects (user_id, name, description, central_question, project_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, description, central_question, project_type, created_at, updated_at`,
    [userId, data.name, data.description ?? null, data.central_question ?? null, data.project_type]
  );

  res.status(201).json({ project: result.rows[0] });
});

/**
 * GET /api/projects/:id
 * Get a single project by ID (verify ownership).
 */
router.get('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    central_question: string | null;
    project_type: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, description, central_question, project_type, created_at, updated_at
     FROM projects
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [projectId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  res.json({ project: result.rows[0] });
});

/**
 * PUT /api/projects/:id
 * Update project metadata.
 */
router.put('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;
  const data = updateProjectSchema.parse(req.body);

  // Build dynamic SET clause from provided fields
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    setClauses.push(`name = $${paramIndex}`);
    values.push(data.name);
    paramIndex++;
  }
  if (data.description !== undefined) {
    setClauses.push(`description = $${paramIndex}`);
    values.push(data.description);
    paramIndex++;
  }
  if (data.central_question !== undefined) {
    setClauses.push(`central_question = $${paramIndex}`);
    values.push(data.central_question);
    paramIndex++;
  }
  if (data.project_type !== undefined) {
    setClauses.push(`project_type = $${paramIndex}`);
    values.push(data.project_type);
    paramIndex++;
  }

  // Add WHERE clause params
  values.push(projectId);
  const projectIdParam = paramIndex;
  paramIndex++;
  values.push(userId);
  const userIdParam = paramIndex;

  const result = await query<{
    id: string;
    name: string;
    description: string | null;
    central_question: string | null;
    project_type: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `UPDATE projects
     SET ${setClauses.join(', ')}
     WHERE id = $${projectIdParam} AND user_id = $${userIdParam} AND archived_at IS NULL
     RETURNING id, name, description, central_question, project_type, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  res.json({ project: result.rows[0] });
});

/**
 * DELETE /api/projects/:id
 * Soft archive a project (sets archived_at timestamp).
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  const result = await query(
    `UPDATE projects
     SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [projectId, userId]
  );

  if (result.rowCount === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  res.status(204).send();
});

export const projectsRouter = router;
