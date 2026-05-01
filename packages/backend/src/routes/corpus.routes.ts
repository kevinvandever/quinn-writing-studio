/**
 * Corpus Routes
 *
 * Handles Scrivener corpus import, document browsing, and change detection.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { query, getClient } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import {
  parseScrivenerZip,
  detectChanges,
  type ParsedDocument,
} from '../services/scrivener-parser.service.js';
import { checkDocumentThemes } from '../services/theme-analysis.service.js';

const router = Router();

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
    const parseResult = parseScrivenerZip(req.file.buffer, req.file.originalname);

    // Get existing documents for this project (for change detection)
    const existingDocs = await query<{
      id: string;
      source_id: string;
      title: string;
      content_hash: string;
      word_count: number;
      content: string;
    }>(
      `SELECT id, source_id, title, content_hash, word_count, content
       FROM corpus_documents
       WHERE project_id = $1 AND source_type = 'scrivener'`,
      [projectId]
    );

    // Detect changes
    const diffSummary = detectChanges(parseResult.documents, existingDocs.rows);

    // Start a transaction for the import
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Create pre-import snapshots for modified documents (Task 9.5)
      for (const modified of diffSummary.modified) {
        const existingDoc = existingDocs.rows.find((d) => d.source_id === modified.uuid);
        if (existingDoc) {
          await client.query(
            `INSERT INTO draft_snapshots (document_id, content, word_count, trigger)
             VALUES ($1, $2, $3, 'pre_import_update')`,
            [existingDoc.id, existingDoc.content, existingDoc.word_count]
          );
        }
      }

      // Create the import record
      const importResult = await client.query<{ id: string }>(
        `INSERT INTO scrivener_imports (project_id, filename, document_count, total_word_count, parse_errors, diff_summary)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          projectId,
          parseResult.filename,
          parseResult.documentCount,
          parseResult.totalWordCount,
          JSON.stringify(parseResult.parseErrors),
          JSON.stringify(diffSummary),
        ]
      );

      const importId = importResult.rows[0]!.id;

      // Delete existing scrivener documents for this project (we'll re-insert)
      await client.query(
        `DELETE FROM corpus_documents WHERE project_id = $1 AND source_type = 'scrivener'`,
        [projectId]
      );

      // Insert all documents from the parse result
      await insertDocuments(client, projectId as string, importId, parseResult.documents, null);

      // Log activity event (Task 9.7)
      const previousTotalWordCount = existingDocs.rows.reduce(
        (sum, doc) => sum + (doc.word_count || 0),
        0
      );
      const wordCountDiff = parseResult.totalWordCount - previousTotalWordCount;

      await client.query(
        `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
         VALUES ($1, $2, 'scrivener_import', $3)`,
        [
          userId,
          projectId,
          JSON.stringify({
            import_id: importId,
            filename: parseResult.filename,
            document_count: parseResult.documentCount,
            total_word_count: parseResult.totalWordCount,
            previous_word_count: previousTotalWordCount,
            word_count_diff: wordCountDiff,
            added_count: diffSummary.added.length,
            modified_count: diffSummary.modified.length,
            deleted_count: diffSummary.deleted.length,
          }),
        ]
      );

      await client.query('COMMIT');

      res.status(201).json({
        import: {
          id: importId,
          filename: parseResult.filename,
          documentCount: parseResult.documentCount,
          totalWordCount: parseResult.totalWordCount,
          parseErrors: parseResult.parseErrors,
          diffSummary,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
 * Recursively insert parsed documents into the database.
 */
async function insertDocuments(
  client: ReturnType<typeof getClient> extends Promise<infer T> ? T : never,
  projectId: string,
  importId: string,
  documents: ParsedDocument[],
  parentId: string | null
): Promise<void> {
  for (const doc of documents) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO corpus_documents (project_id, source_type, source_id, title, content, content_hash, word_count, parent_id, sort_order, is_folder, import_id)
       VALUES ($1, 'scrivener', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        projectId,
        doc.uuid,
        doc.title,
        doc.content,
        doc.contentHash,
        doc.wordCount,
        parentId,
        doc.sortOrder,
        doc.isFolder,
        importId,
      ]
    );

    const insertedId = result.rows[0]!.id;

    // Recursively insert children
    if (doc.children.length > 0) {
      await insertDocuments(client, projectId, importId, doc.children, insertedId);
    }
  }
}

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
