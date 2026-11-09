/**
 * Scrivener Sync Service
 *
 * Applies a parsed Scrivener binder to `corpus_documents`. Used by both the ZIP
 * upload route and the local watcher's sync route.
 *
 * Rows are updated in place, keyed by Scrivener's binder UUID (`source_id`), so
 * every piece keeps its database id from one sync to the next. Everything Quinn
 * learns about a piece hangs off that id:
 *   - per-piece summaries and themes, and journal earmarks (`metadata`)
 *   - draft snapshots (`draft_snapshots`, ON DELETE CASCADE)
 *   - theme connections (`theme_connections`, ON DELETE CASCADE)
 * The previous implementation deleted and re-inserted the whole binder on every
 * sync, which erased all of the above each time.
 *
 * Only pieces that have left the binder entirely are deleted. Scrivener's Trash
 * is part of the binder, so trashed pieces keep their rows until Trash is emptied.
 */
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getClient } from '../db/connection.js';
import { decodeCp1252Controls } from '../utils/rtf-parser.js';
import {
  detectChanges,
  flattenDocuments,
  type DiffSummary,
  type ParsedDocument,
} from './scrivener-parser.service.js';

// ─── Input validation ────────────────────────────────────────────────────────

/** Shape of one binder node as produced by the Scrivener parsers. */
export const parsedDocumentSchema: z.ZodType<ParsedDocument> = z.lazy(() =>
  z.object({
    uuid: z.string().min(1).max(255),
    title: z.string(),
    content: z.string(),
    wordCount: z.number().int().nonnegative(),
    contentHash: z.string().max(64),
    isFolder: z.boolean(),
    scrivenerType: z.string().max(100),
    sortOrder: z.number().int(),
    children: z.array(parsedDocumentSchema),
  })
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScrivenerImportInput {
  projectId: string;
  userId: string;
  filename: string;
  documents: ParsedDocument[];
  documentCount: number;
  totalWordCount: number;
  parseErrors: Array<{ documentName: string; error: string }>;
  /** Recorded on the activity event. */
  source: 'upload' | 'watcher';
  /** When true and nothing changed, write nothing and return importId null. */
  skipIfUnchanged: boolean;
}

export interface ScrivenerImportResult {
  /** Null when skipIfUnchanged was set and the binder had no changes. */
  importId: string | null;
  diffSummary: DiffSummary;
}

interface ExistingRow {
  id: string;
  source_id: string | null;
  title: string | null;
  content: string | null;
  content_hash: string | null;
  word_count: number | null;
  is_folder: boolean;
  sort_order: number | null;
  /** Scrivener UUID of the parent row, or null at the top level. */
  parent_source_id: string | null;
  /** The content_hash the piece's summary was made from. */
  summary_hash: string | null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * The text as it should be stored, with its hash computed here rather than
 * trusted from the sender. Parsers before the fix decoded RTF's \'XX escapes
 * as Latin-1, which turned curly quotes, apostrophes, and dashes into
 * invisible control characters (U+0080-U+009F); decoding them here fixes text
 * from any version of the watcher. PostgreSQL rejects null bytes in text.
 */
function normalizeDocuments(nodes: ParsedDocument[]): ParsedDocument[] {
  return nodes.map((node) => {
    const content = decodeCp1252Controls(node.content || '').replace(/\0/g, '');
    return { ...node, content, contentHash: sha256(content), children: normalizeDocuments(node.children) };
  });
}

/** Thrown for input that would wipe the corpus rather than update it. */
export class EmptyBinderError extends Error {
  constructor() {
    super('The Scrivener import contained no binder items, so nothing was changed.');
    this.name = 'EmptyBinderError';
  }
}

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Apply a parsed Scrivener binder to the project's corpus in one transaction.
 */
export async function applyScrivenerImport(
  input: ScrivenerImportInput
): Promise<ScrivenerImportResult> {
  const { projectId, userId } = input;
  const documents = normalizeDocuments(input.documents);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Serialize syncs per project, so a watcher sync and a manual upload that
    // overlap can't both insert the same new pieces.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `scrivener-sync:${projectId}`,
    ]);

    const existingResult = await client.query<ExistingRow>(
      `SELECT d.id, d.source_id, d.title, d.content, d.content_hash, d.word_count, d.is_folder,
              d.sort_order, p.source_id AS parent_source_id, d.metadata->>'summaryHash' AS summary_hash
       FROM corpus_documents d
       LEFT JOIN corpus_documents p ON p.id = d.parent_id
       WHERE d.project_id = $1 AND d.source_type = 'scrivener'`,
      [projectId]
    );
    const existing = existingResult.rows;

    // A real binder always has at least the Draft, Research, and Trash folders.
    // An empty tree means something went wrong upstream; applying it would
    // delete every piece and everything attached to it.
    if (documents.length === 0 && existing.length > 0) {
      throw new EmptyBinderError();
    }

    // Pieces stored by the old parser differ from the same text decoded
    // correctly only in their quotes and dashes. That isn't a revision: the
    // text is updated without a snapshot, a new "last changed" date, a new
    // summary, or a place in the list of changes Quinn sees.
    const incoming = new Map<string, ParsedDocument>();
    for (const d of flattenDocuments(documents)) if (!incoming.has(d.uuid)) incoming.set(d.uuid, d);
    const reencoded = new Map<string, ParsedDocument>();
    for (const r of existing) {
      const now = r.source_id ? incoming.get(r.source_id) : undefined;
      if (now && r.content_hash !== now.contentHash && decodeCp1252Controls(r.content ?? '') === now.content) {
        reencoded.set(r.id, now);
      }
    }

    const diffSummary = detectChanges(
      documents,
      existing.map((r) => ({
        source_id: r.source_id ?? '',
        title: r.title ?? '',
        content_hash: reencoded.get(r.id)?.contentHash ?? r.content_hash ?? '',
        word_count: r.word_count ?? 0,
        parent_source_id: r.parent_source_id,
        sort_order: r.sort_order,
      }))
    );

    // Renames, moves, and reorders count: before, a sync that only moved a
    // piece (say, from SALVAGE into the book) was skipped as "unchanged".
    const unchanged =
      diffSummary.added.length === 0 &&
      diffSummary.modified.length === 0 &&
      diffSummary.deleted.length === 0 &&
      (diffSummary.renamed?.length ?? 0) === 0 &&
      (diffSummary.moved?.length ?? 0) === 0 &&
      (diffSummary.reordered?.length ?? 0) === 0;
    if (input.skipIfUnchanged && unchanged) {
      // Nothing the writer did, so no import is recorded; fixed text is still stored.
      for (const [id, doc] of reencoded) {
        await client.query(
          `UPDATE corpus_documents
           SET content = $2,
               content_hash = $3::text,
               word_count = $4,
               metadata = CASE WHEN metadata->>'summaryHash' = content_hash
                               THEN jsonb_set(metadata, '{summaryHash}', to_jsonb($3::text))
                               ELSE metadata END
           WHERE id = $1`,
          [id, doc.content, doc.contentHash, doc.wordCount]
        );
      }
      await client.query(reencoded.size > 0 ? 'COMMIT' : 'ROLLBACK');
      return { importId: null, diffSummary };
    }

    const existingBySourceId = new Map<string, ExistingRow>();
    for (const row of existing) {
      if (row.source_id && !existingBySourceId.has(row.source_id)) {
        existingBySourceId.set(row.source_id, row);
      }
    }

    // Keep the previous text of every revised piece. Because rows are no longer
    // deleted, these snapshots now survive the sync.
    for (const modified of diffSummary.modified) {
      const prior = existingBySourceId.get(modified.uuid);
      if (prior) {
        await client.query(
          `INSERT INTO draft_snapshots (document_id, content, word_count, trigger)
           VALUES ($1, $2, $3, 'pre_import_update')`,
          [prior.id, decodeCp1252Controls(prior.content ?? ''), prior.word_count]
        );
      }
    }

    const importResult = await client.query<{ id: string }>(
      `INSERT INTO scrivener_imports (project_id, filename, document_count, total_word_count, parse_errors, diff_summary)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        projectId,
        input.filename,
        input.documentCount,
        input.totalWordCount,
        JSON.stringify(input.parseErrors || []),
        JSON.stringify(diffSummary),
      ]
    );
    const importId = importResult.rows[0]!.id;

    const keptIds: string[] = [];
    const reencodedIds = new Set(reencoded.keys());
    await upsertNodes(client, projectId, importId, documents, null, existingBySourceId, reencodedIds, keptIds);

    // Remove only pieces that are no longer anywhere in the binder.
    await client.query(
      `DELETE FROM corpus_documents
       WHERE project_id = $1 AND source_type = 'scrivener' AND NOT (id = ANY($2::uuid[]))`,
      [projectId, keptIds]
    );

    // Folder rows carry the sum of their children's words, so count documents
    // only. (Summing every row counted each word once per enclosing folder,
    // which made every sync look like a loss of hundreds of thousands of words.)
    const previousTotalWordCount = existing
      .filter((r) => !r.is_folder)
      .reduce((sum, r) => sum + (r.word_count || 0), 0);
    const wordCountDiff = input.totalWordCount - previousTotalWordCount;

    await client.query(
      `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
       VALUES ($1, $2, 'scrivener_import', $3)`,
      [
        userId,
        projectId,
        JSON.stringify({
          import_id: importId,
          filename: input.filename,
          document_count: input.documentCount,
          total_word_count: input.totalWordCount,
          previous_word_count: previousTotalWordCount,
          word_count_diff: wordCountDiff,
          added_count: diffSummary.added.length,
          modified_count: diffSummary.modified.length,
          deleted_count: diffSummary.deleted.length,
          source: input.source,
        }),
      ]
    );

    await client.query('COMMIT');
    return { importId, diffSummary };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Walk the binder depth-first, updating rows that already exist (by Scrivener
 * UUID) and inserting new ones. Parents are written before their children so
 * every parent_id points at a row in its final state.
 */
async function upsertNodes(
  client: PoolClient,
  projectId: string,
  importId: string,
  nodes: ParsedDocument[],
  parentId: string | null,
  existingBySourceId: Map<string, ExistingRow>,
  reencodedIds: Set<string>,
  keptIds: string[]
): Promise<void> {
  for (const node of nodes) {
    // Content is already normalized (normalizeDocuments), null bytes included.
    const content = node.content || '';
    const title = (node.title || '').replace(/\0/g, '').slice(0, 500);

    const prior = existingBySourceId.get(node.uuid);
    // A UUID should appear once per binder; if it repeats, only the first
    // occurrence reuses the existing row.
    if (prior) existingBySourceId.delete(node.uuid);

    let id: string;
    if (prior) {
      // Text that only had its quotes and dashes fixed keeps its "last changed"
      // date, and its summary still describes it.
      const reencoded = reencodedIds.has(prior.id);
      const metadata: Record<string, unknown> = { scrivenerType: node.scrivenerType ?? null };
      if (reencoded && prior.summary_hash && prior.summary_hash === prior.content_hash) {
        metadata.summaryHash = node.contentHash;
      }
      // Merge metadata so summaries, themes, and earmarks survive. updated_at
      // moves only when the text changed. (Right-hand sides read the old row.)
      await client.query(
        `UPDATE corpus_documents
         SET title = $2,
             content = $3,
             word_count = $5,
             parent_id = $6,
             sort_order = $7,
             is_folder = $8,
             metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
             import_id = $10,
             updated_at = CASE WHEN content_hash IS DISTINCT FROM $4 AND NOT $11::boolean THEN NOW() ELSE updated_at END,
             content_hash = $4
         WHERE id = $1`,
        [
          prior.id,
          title,
          content,
          node.contentHash,
          node.wordCount,
          parentId,
          node.sortOrder,
          node.isFolder,
          JSON.stringify(metadata),
          importId,
          reencoded,
        ]
      );
      id = prior.id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO corpus_documents (project_id, source_type, source_id, title, content, content_hash, word_count, parent_id, sort_order, is_folder, metadata, import_id)
         VALUES ($1, 'scrivener', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          projectId,
          node.uuid,
          title,
          content,
          node.contentHash,
          node.wordCount,
          parentId,
          node.sortOrder,
          node.isFolder,
          JSON.stringify({ scrivenerType: node.scrivenerType ?? null }),
          importId,
        ]
      );
      id = inserted.rows[0]!.id;
    }

    keptIds.push(id);

    if (node.children.length > 0) {
      await upsertNodes(client, projectId, importId, node.children, id, existingBySourceId, reencodedIds, keptIds);
    }
  }
}
