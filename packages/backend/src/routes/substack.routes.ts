/**
 * Substack Integration Routes
 *
 * Configure Substack connections, trigger syncs, and check status.
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { syncSubstackPosts, type SubstackConnection } from '../services/substack-sync.service.js';

const router = Router();

// Apply auth middleware to all substack routes
router.use(requireAuth);

/**
 * POST /api/integrations/substack
 * Configure a Substack connection for a project.
 */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { project_id, publication_url, publication_name, auth_cookies } = req.body;

  if (!project_id || !publication_url) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'project_id and publication_url are required'
    );
  }

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [project_id, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  // Check if connection already exists for this project
  const existing = await query<{ id: string }>(
    'SELECT id FROM substack_connections WHERE project_id = $1',
    [project_id]
  );

  let connection;

  if (existing.rows.length > 0) {
    // Update existing connection
    const result = await query<SubstackConnection>(
      `UPDATE substack_connections
       SET publication_url = $1, publication_name = $2, auth_cookies = $3
       WHERE project_id = $4
       RETURNING id, project_id, publication_url, publication_name, last_sync_at, sync_status, sync_error`,
      [publication_url, publication_name || null, auth_cookies || null, project_id]
    );
    connection = result.rows[0];
  } else {
    // Create new connection
    const result = await query<SubstackConnection>(
      `INSERT INTO substack_connections (project_id, publication_url, publication_name, auth_cookies)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, publication_url, publication_name, last_sync_at, sync_status, sync_error`,
      [project_id, publication_url, publication_name || null, auth_cookies || null]
    );
    connection = result.rows[0];
  }

  res.status(201).json({ connection });
});

/**
 * POST /api/integrations/substack/sync
 * Trigger a manual sync for a project's Substack connection.
 */
router.post('/sync', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { project_id } = req.body;

  if (!project_id) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'project_id is required');
  }

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [project_id, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  // Load connection
  const connectionResult = await query<SubstackConnection>(
    `SELECT id, project_id, publication_url, publication_name, auth_cookies, last_sync_at, sync_status, sync_error
     FROM substack_connections
     WHERE project_id = $1`,
    [project_id]
  );

  if (connectionResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'No Substack connection configured for this project');
  }

  const connection = connectionResult.rows[0]!;

  // Perform sync
  const result = await syncSubstackPosts(connection, userId);

  res.json({
    sync: {
      postsFound: result.postsFound,
      newPosts: result.newPosts,
      errors: result.errors,
    },
  });
});

/**
 * GET /api/integrations/substack/status
 * Get sync status for all Substack connections belonging to the user.
 */
router.get('/status', async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const result = await query<{
    id: string;
    project_id: string;
    publication_url: string;
    publication_name: string | null;
    last_sync_at: Date | null;
    sync_status: string;
    sync_error: string | null;
  }>(
    `SELECT sc.id, sc.project_id, sc.publication_url, sc.publication_name, sc.last_sync_at, sc.sync_status, sc.sync_error
     FROM substack_connections sc
     JOIN projects p ON p.id = sc.project_id
     WHERE p.user_id = $1`,
    [userId]
  );

  res.json({ connections: result.rows });
});

export const substackRouter = router;
