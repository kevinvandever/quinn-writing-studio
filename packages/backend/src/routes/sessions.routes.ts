import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { claudeApiLimiter } from '../middleware/rate-limit.middleware.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import {
  startSession,
  sendSessionMessage,
  endSession,
  type SessionType,
} from '../services/coaching.service.js';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const startSessionSchema = z.object({
  session_type: z.enum(['coaching', 'editorial_review', 'theme_analysis', 'promptly_coaching']),
});

const sendMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required').max(50000),
});

// ─── Project-scoped session routes ───────────────────────────────────────────

/**
 * POST /api/projects/:id/sessions
 * Start a new coaching session for a project.
 */
router.post(
  '/projects/:id/sessions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const projectId = req.params.id as string;
    const data = startSessionSchema.parse(req.body);

    const sessionContext = await startSession(
      userId,
      projectId,
      data.session_type as SessionType
    );

    res.status(201).json({ session: sessionContext });
  })
);

/**
 * GET /api/projects/:id/sessions
 * List sessions for a project with pagination.
 */
router.get(
  '/projects/:id/sessions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const projectId = req.params.id as string;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    // Verify project ownership
    const projectResult = await query(
      `SELECT id FROM projects WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [projectId, userId]
    );

    if (projectResult.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    }

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM sessions WHERE project_id = $1`,
      [projectId]
    );

    const total = parseInt(countResult.rows[0]?.count ?? '0');

    // Get sessions
    const sessionsResult = await query<{
      id: string;
      project_id: string;
      session_type: string;
      summary: string | null;
      next_steps: string | null;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT id, project_id, session_type, summary, next_steps, started_at, ended_at
       FROM sessions
       WHERE project_id = $1
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [projectId, limit, offset]
    );

    res.json({
      sessions: sessionsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

/**
 * GET /api/sessions/:id
 * Get a session with its messages.
 */
router.get(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const sessionId = req.params.id as string;

    // Load session and verify ownership through project
    const sessionResult = await query<{
      id: string;
      project_id: string;
      session_type: string;
      summary: string | null;
      next_steps: string | null;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT s.id, s.project_id, s.session_type, s.summary, s.next_steps, s.started_at, s.ended_at
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND p.user_id = $2`,
      [sessionId, userId]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Session not found');
    }

    const session = sessionResult.rows[0];

    // Load messages
    const messagesResult = await query<{
      id: string;
      role: string;
      content: string;
      model_used: string | null;
      model_reason: string | null;
      token_count_input: number | null;
      token_count_output: number | null;
      created_at: Date;
    }>(
      `SELECT id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
       FROM messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );

    res.json({
      session,
      messages: messagesResult.rows,
    });
  })
);

/**
 * POST /api/sessions/:id/messages
 * Send a message in a coaching session. Response is streamed via SSE.
 */
router.post(
  '/sessions/:id/messages',
  requireAuth,
  claudeApiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const sessionId = req.params.id as string;
    const data = sendMessageSchema.parse(req.body);

    // Verify session ownership through project
    const sessionCheck = await query(
      `SELECT s.id FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND p.user_id = $2`,
      [sessionId, userId]
    );

    if (sessionCheck.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Session not found');
    }

    await sendSessionMessage(userId, sessionId, data.content, res);
  })
);

/**
 * POST /api/sessions/:id/end
 * End a coaching session and trigger summary generation.
 */
router.post(
  '/sessions/:id/end',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const sessionId = req.params.id as string;

    // Verify session ownership through project
    const sessionCheck = await query(
      `SELECT s.id FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = $1 AND p.user_id = $2`,
      [sessionId, userId]
    );

    if (sessionCheck.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Session not found');
    }

    const result = await endSession(userId, sessionId);

    res.json({
      summary: result.summary,
      next_steps: result.nextSteps,
    });
  })
);

export const sessionsRouter = router;
