/**
 * Corpus Routes
 *
 * Handles Scrivener corpus import, document browsing, and change detection.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import {
  parseScrivenerZip,
  type ScrivenerParseResult,
} from '../services/scrivener-parser.service.js';
import {
  applyScrivenerImport,
  EmptyBinderError,
  parsedDocumentSchema,
  type ScrivenerImportInput,
  type ScrivenerImportResult,
} from '../services/scrivener-sync.service.js';
import { checkDocumentThemes } from '../services/theme-analysis.service.js';
import { ensureCorpusSummaries } from '../services/corpus-summary.service.js';
import {
  loadSnapshotKeys,
  snapshotUploadSchema,
  storeScrivenerSnapshots,
} from '../services/scrivener-snapshots.service.js';

const router = Router();

/** Body the local watcher posts to /corpus/sync. */
const syncBodySchema = z.object({
  filename: z.string().min(1),
  documents: z.array(parsedDocumentSchema),
  totalWordCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  parseErrors: z
    .array(z.object({ documentName: z.string(), error: z.string() }))
    .optional()
    .default([]),
});

/** Apply an import, turning an empty-binder refusal into a 400. */
async function runScrivenerImport(input: ScrivenerImportInput): Promise<ScrivenerImportResult> {
  try {
    return await applyScrivenerImport(input);
  } catch (err) {
    if (err instanceof EmptyBinderError) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, err.message);
    }
    throw err;
  }
}

// Configure multer for in-memory file upload (max 50MB for .scriv ZIPs)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Accept ZIP files and .scriv bundles
    if (
      file.mimetype === 'application/zip' ||
      file.mimetype === 'application/x-zip-compressed' ||
      file.originalname.endsWith('.zip') ||
      file.originalname.endsWith('.scriv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip and .scriv files are accepted'));
    }
  },
});

// Apply auth middleware to all corpus routes
router.use(requireAuth);

/**
 * POST /api/projects/:id/corpus/upload
 * Upload a .scriv ZIP package, parse it, and store documents.
 */
router.post(
  '/projects/:id/corpus/upload',
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const projectId = req.params.id;

    if (!req.file) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'No file uploaded');
    }

    // Verify project ownership
    const projectResult = await query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, userId]
    );

    if (projectResult.rows.length === 0) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
    }

    // Parse the Scrivener ZIP
    let parseResult: ScrivenerParseResult;
    try {
      parseResult = parseScrivenerZip(req.file.buffer, req.file.originalname);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse file';
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `Scrivener import failed: ${message}`);
    }

    // Update the corpus in place (keyed by Scrivener UUID) so summaries,
    // earmarks, draft snapshots, and theme links survive the import.
    const { importId, diffSummary } = await runScrivenerImport({
      projectId: projectId as string,
      userId,
      filename: parseResult.filename,
      documents: parseResult.documents,
      documentCount: parseResult.documentCount,
      totalWordCount: parseResult.totalWordCount,
      parseErrors: parseResult.parseErrors,
      source: 'upload',
      skipIfUnchanged: false,
    });

    // Generate per-document summaries in the background (non-blocking).
    void ensureCorpusSummaries(projectId as string, userId);

    // Scrivener's snapshots become draft versions, for revision history.
    // A failure here shouldn't fail an import that already succeeded.
    let snapshots = { stored: 0, skipped: 0 };
    try {
      snapshots = await storeScrivenerSnapshots(projectId as string, parseResult.snapshots ?? []);
    } catch (err) {
      console.warn('[Corpus] Storing Scrivener snapshots failed:', err instanceof Error ? err.message : err);
    }

    res.status(201).json({
      snapshots,
      import: {
        id: importId,
        filename: parseResult.filename,
        documentCount: parseResult.documentCount,
        totalWordCount: parseResult.totalWordCount,
        parseErrors: parseResult.parseErrors,
        diffSummary,
      },
    });
  })
);

/**
 * GET /api/projects/:id/corpus
 * Get the corpus tree structure for a project.
 */
router.get('/projects/:id/corpus', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  // Get all documents for this project
  const docsResult = await query<{
    id: string;
    source_type: string;
    source_id: string;
    title: string;
    word_count: number;
    parent_id: string | null;
    sort_order: number;
    is_folder: boolean;
    metadata: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, source_type, source_id, title, word_count, parent_id, sort_order, is_folder, metadata, created_at, updated_at
     FROM corpus_documents
     WHERE project_id = $1
     ORDER BY sort_order ASC`,
    [projectId]
  );

  // Build tree structure
  const tree = buildTree(docsResult.rows);

  res.json({ documents: tree });
}));

/**
 * GET /api/corpus/documents/:id
 * Get a single document's content.
 */
router.get('/corpus/documents/:id', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const documentId = req.params.id;

  const result = await query<{
    id: string;
    project_id: string;
    source_type: string;
    source_id: string;
    title: string;
    content: string;
    content_hash: string;
    word_count: number;
    parent_id: string | null;
    sort_order: number;
    is_folder: boolean;
    metadata: unknown;
    import_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT cd.* FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.id = $1 AND p.user_id = $2`,
    [documentId, userId]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Document not found');
  }

  res.json({ document: result.rows[0] });
}));

/**
 * GET /api/projects/:id/corpus/imports
 * List import history for a project.
 */
router.get('/projects/:id/corpus/imports', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  const result = await query<{
    id: string;
    filename: string;
    document_count: number;
    total_word_count: number;
    parse_errors: unknown;
    diff_summary: unknown;
    imported_at: Date;
  }>(
    `SELECT id, filename, document_count, total_word_count, parse_errors, diff_summary, imported_at
     FROM scrivener_imports
     WHERE project_id = $1
     ORDER BY imported_at DESC`,
    [projectId]
  );

  res.json({ imports: result.rows });
}));

/**
 * POST /api/projects/:id/corpus/sync
 * Accept pre-parsed Scrivener data as JSON (used by the local watcher agent).
 * Same logic as the upload endpoint but skips the ZIP parsing step.
 */
router.post('/projects/:id/corpus/sync', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;
  const { filename, documents, totalWordCount, documentCount, parseErrors } = syncBodySchema.parse(req.body);

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  // Update the corpus in place (keyed by Scrivener UUID) so summaries,
  // earmarks, draft snapshots, and theme links survive the sync.
  const { importId, diffSummary } = await runScrivenerImport({
    projectId: projectId as string,
    userId,
    filename,
    documents,
    documentCount,
    totalWordCount,
    parseErrors,
    source: 'watcher',
    skipIfUnchanged: true,
  });

  if (!importId) {
    res.json({ import: null, message: 'No changes detected' });
    return;
  }

  // Generate per-document summaries in the background (non-blocking).
  void ensureCorpusSummaries(projectId as string, userId);

  res.status(201).json({
    import: {
      id: importId,
      filename,
      documentCount,
      totalWordCount,
      parseErrors,
      diffSummary,
    },
  });
}));

/** Throw a 404 unless the project belongs to the user. */
async function requireOwnedProject(projectId: string, userId: string): Promise<void> {
  const result = await query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
  if (result.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }
}

/**
 * GET /api/projects/:id/corpus/snapshots/keys
 * Which Scrivener snapshots the server has ("<document UUID>|<ISO time>"), so
 * the watcher uploads only new ones.
 */
router.get('/projects/:id/corpus/snapshots/keys', asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  await requireOwnedProject(projectId, req.user!.userId);
  res.json({ keys: await loadSnapshotKeys(projectId) });
}));

/**
 * POST /api/projects/:id/corpus/snapshots
 * Store Scrivener snapshots the watcher parsed from a backup, as draft
 * versions. Snapshots the project already has are skipped.
 */
router.post('/projects/:id/corpus/snapshots', asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const { snapshots } = snapshotUploadSchema.parse(req.body);
  await requireOwnedProject(projectId, req.user!.userId);
  res.status(201).json(await storeScrivenerSnapshots(projectId, snapshots));
}));

/**
 * POST /api/projects/:id/drafts/upload
 * Manual paste/upload fallback for adding content to corpus.
 * Accepts { title, content } in body and stores as corpus_document with source_type='manual_upload'.
 */
router.post('/projects/:id/drafts/upload', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;
  const { title, content } = req.body;

  if (!title || !content) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'title and content are required');
  }

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  // Count words
  const wordCount = content.split(/\s+/).filter((w: string) => w.length > 0).length;

  // Store as corpus document
  const result = await query<{
    id: string;
    project_id: string;
    source_type: string;
    title: string;
    word_count: number;
    created_at: Date;
  }>(
    `INSERT INTO corpus_documents (project_id, source_type, title, content, word_count)
     VALUES ($1, 'manual_upload', $2, $3, $4)
     RETURNING id, project_id, source_type, title, word_count, created_at`,
    [projectId, title, content, wordCount]
  );

  // Check for thematic connections to existing documents (async, non-blocking)
  const newDocId = result.rows[0]!.id;
  checkDocumentThemes(userId, newDocId).catch((err) => {
    console.error('[Corpus] Theme check failed for new document:', err);
  });

  res.status(201).json({ document: result.rows[0] });
}));

/**
 * GET /api/projects/:id/corpus/diff
 * Get the change summary for the latest import.
 */
router.get('/projects/:id/corpus/diff', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const projectId = req.params.id;

  // Verify project ownership
  const projectResult = await query<{ id: string }>(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Project not found');
  }

  const result = await query<{
    id: string;
    filename: string;
    diff_summary: unknown;
    imported_at: Date;
  }>(
    `SELECT id, filename, diff_summary, imported_at
     FROM scrivener_imports
     WHERE project_id = $1
     ORDER BY imported_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (result.rows.length === 0) {
    res.json({ diff: null, message: 'No imports found for this project' });
    return;
  }

  res.json({
    importId: result.rows[0]!.id,
    filename: result.rows[0]!.filename,
    diff: result.rows[0]!.diff_summary,
    importedAt: result.rows[0]!.imported_at,
  });
}));

/**
 * Build a tree structure from flat document rows.
 */
function buildTree(
  rows: Array<{
    id: string;
    source_type: string;
    source_id: string;
    title: string;
    word_count: number;
    parent_id: string | null;
    sort_order: number;
    is_folder: boolean;
    metadata: unknown;
    created_at: Date;
    updated_at: Date;
  }>
): unknown[] {
  interface TreeNode {
    id: string;
    sourceType: string;
    sourceId: string;
    title: string;
    wordCount: number;
    sortOrder: number;
    isFolder: boolean;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
    children: TreeNode[];
  }

  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create all nodes
  for (const row of rows) {
    nodeMap.set(row.id, {
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      wordCount: row.word_count,
      sortOrder: row.sort_order,
      isFolder: row.is_folder,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      children: [],
    });
  }

  // Build parent-child relationships
  for (const row of rows) {
    const node = nodeMap.get(row.id)!;
    if (row.parent_id && nodeMap.has(row.parent_id)) {
      nodeMap.get(row.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by sort_order
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  roots.sort((a, b) => a.sortOrder - b.sortOrder);

  return roots;
}

export const corpusRouter = router;
