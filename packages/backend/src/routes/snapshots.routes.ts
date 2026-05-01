/**
 * Snapshot Routes
 *
 * Handles draft versioning: create, list, view, compare, and delete snapshots.
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';

const router = Router();

// Apply auth middleware to all snapshot routes
router.use(requireAuth);

/**
 * POST /api/documents/:id/snapshots
 * Create a manual snapshot of a document.
 */
router.post('/documents/:id/snapshots', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const documentId = req.params.id;

  // Verify document exists and user owns the project
  const docResult = await query<{
    id: string;
    content: string;
    word_count: number;
    project_id: string;
  }>(
    `SELECT cd.id, cd.content, cd.word_count, cd.project_id
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.id = $1 AND p.user_id = $2`,
    [documentId, userId]
  );

  if (docResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Document not found');
  }

  const doc = docResult.rows[0]!;

  // Create the snapshot
  const snapshotResult = await query<{
    id: string;
    document_id: string;
    word_count: number;
    trigger: string;
    created_at: Date;
  }>(
    `INSERT INTO draft_snapshots (document_id, content, word_count, trigger)
     VALUES ($1, $2, $3, 'manual')
     RETURNING id, document_id, word_count, trigger, created_at`,
    [documentId, doc.content, doc.word_count]
  );

  res.status(201).json({ snapshot: snapshotResult.rows[0] });
}));

/**
 * GET /api/documents/:id/snapshots
 * List all snapshots for a document.
 */
router.get('/documents/:id/snapshots', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const documentId = req.params.id;

  // Verify document exists and user owns the project
  const docResult = await query<{ id: string }>(
    `SELECT cd.id
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.id = $1 AND p.user_id = $2`,
    [documentId, userId]
  );

  if (docResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Document not found');
  }

  const snapshots = await query<{
    id: string;
    document_id: string;
    word_count: number;
    trigger: string;
    created_at: Date;
  }>(
    `SELECT id, document_id, word_count, trigger, created_at
     FROM draft_snapshots
     WHERE document_id = $1
     ORDER BY created_at DESC`,
    [documentId]
  );

  res.json({ snapshots: snapshots.rows });
}));

/**
 * GET /api/snapshots/:id
 * Get a single snapshot's content.
 */
router.get('/snapshots/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const snapshotId = req.params.id;

  const result = await query<{
    id: string;
    document_id: string;
    content: string;
    word_count: number;
    trigger: string;
    created_at: Date;
  }>(
    `SELECT ds.id, ds.document_id, ds.content, ds.word_count, ds.trigger, ds.created_at
     FROM draft_snapshots ds
     JOIN corpus_documents cd ON cd.id = ds.document_id
     JOIN projects p ON p.id = cd.project_id
     WHERE ds.id = $1 AND p.user_id = $2`,
    [snapshotId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Snapshot not found');
  }

  res.json({ snapshot: result.rows[0] });
}));

/**
 * GET /api/documents/:id/snapshots/diff
 * Compare two snapshots. Accepts `a` and `b` query params for snapshot IDs.
 */
router.get('/documents/:id/snapshots/diff', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const documentId = req.params.id;
  const snapshotAId = req.query.a as string;
  const snapshotBId = req.query.b as string;

  if (!snapshotAId || !snapshotBId) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      'Both snapshot IDs (a and b) are required as query parameters'
    );
  }

  // Verify document ownership
  const docResult = await query<{ id: string }>(
    `SELECT cd.id
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.id = $1 AND p.user_id = $2`,
    [documentId, userId]
  );

  if (docResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Document not found');
  }

  // Load both snapshots
  const snapshotsResult = await query<{
    id: string;
    content: string;
    word_count: number;
    created_at: Date;
  }>(
    `SELECT id, content, word_count, created_at
     FROM draft_snapshots
     WHERE id IN ($1, $2) AND document_id = $3`,
    [snapshotAId, snapshotBId, documentId]
  );

  if (snapshotsResult.rows.length < 2) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'One or both snapshots not found for this document');
  }

  const snapshotA = snapshotsResult.rows.find((s) => s.id === snapshotAId)!;
  const snapshotB = snapshotsResult.rows.find((s) => s.id === snapshotBId)!;

  // Compute word count delta
  const wordCountDelta = (snapshotB.word_count || 0) - (snapshotA.word_count || 0);

  res.json({
    diff: {
      snapshotA: {
        id: snapshotA.id,
        content: snapshotA.content,
        wordCount: snapshotA.word_count,
        createdAt: snapshotA.created_at,
      },
      snapshotB: {
        id: snapshotB.id,
        content: snapshotB.content,
        wordCount: snapshotB.word_count,
        createdAt: snapshotB.created_at,
      },
      wordCountDelta,
    },
  });
}));

/**
 * DELETE /api/snapshots/:id
 * Delete a snapshot.
 */
router.delete('/snapshots/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const snapshotId = req.params.id;

  // Verify ownership through project
  const result = await query<{ id: string }>(
    `SELECT ds.id
     FROM draft_snapshots ds
     JOIN corpus_documents cd ON cd.id = ds.document_id
     JOIN projects p ON p.id = cd.project_id
     WHERE ds.id = $1 AND p.user_id = $2`,
    [snapshotId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Snapshot not found');
  }

  await query('DELETE FROM draft_snapshots WHERE id = $1', [snapshotId]);

  res.status(204).send();
}));

export const snapshotsRouter = router;
