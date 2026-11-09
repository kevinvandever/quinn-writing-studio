/**
 * Scrivener Snapshots
 *
 * Stores the snapshots Scrivener keeps for each document (versions the writer
 * saved, and the ones Scrivener takes before an external-folder sync) as draft
 * versions, so Quinn can see how a piece has changed over time.
 *
 * Migration-free: each snapshot becomes a draft_snapshots row (trigger
 * 'manual', created_at = when it was taken), and the document's metadata keeps
 * an index of the Scrivener snapshots it has received, keyed by time, with
 * their titles: metadata.scrivenerSnapshots = { "<ISO time>": "<title>" }.
 * The index is also how the watcher learns which snapshots the server already
 * has, so a version deleted in the app isn't uploaded again.
 */
import { z } from 'zod';
import { getClient, query } from '../db/connection.js';
import { decodeCp1252Controls } from '../utils/rtf-parser.js';

export const snapshotUploadSchema = z.object({
  snapshots: z
    .array(
      z.object({
        uuid: z.string().min(1).max(100),
        takenAt: z.string().datetime(),
        title: z.string().max(500),
        content: z.string().max(2_000_000),
        wordCount: z.number().int().nonnegative(),
        contentHash: z.string().max(128).optional(),
      })
    )
    .max(2000),
});

export type SnapshotUpload = z.infer<typeof snapshotUploadSchema>['snapshots'][number];

/** The index as a JSON object, whatever is stored (absent, null, or not an object). */
const INDEX_SQL = `CASE WHEN jsonb_typeof(metadata->'scrivenerSnapshots') = 'object'
                        THEN metadata->'scrivenerSnapshots' ELSE '{}'::jsonb END`;

/** Keys ("<document UUID>|<ISO time>") of the Scrivener snapshots a project already has. */
export async function loadSnapshotKeys(projectId: string): Promise<string[]> {
  const result = await query<{ source_id: string; taken_at: string }>(
    `SELECT cd.source_id, k.key AS taken_at
     FROM corpus_documents cd
     CROSS JOIN LATERAL jsonb_object_keys(
       CASE WHEN jsonb_typeof(cd.metadata->'scrivenerSnapshots') = 'object'
            THEN cd.metadata->'scrivenerSnapshots' ELSE '{}'::jsonb END
     ) AS k(key)
     WHERE cd.project_id = $1 AND cd.source_type = 'scrivener' AND cd.source_id IS NOT NULL`,
    [projectId]
  );
  return result.rows.map((r) => `${r.source_id}|${r.taken_at}`);
}

/**
 * Store snapshots the project doesn't have yet. Snapshots of documents that
 * aren't in the project are skipped (the next upload retries them).
 */
export async function storeScrivenerSnapshots(
  projectId: string,
  snapshots: SnapshotUpload[]
): Promise<{ stored: number; skipped: number }> {
  if (snapshots.length === 0) return { stored: 0, skipped: 0 };
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const docs = await client.query<{ id: string; source_id: string; snapshot_index: Record<string, string> }>(
      `SELECT id, source_id, ${INDEX_SQL} AS snapshot_index
       FROM corpus_documents
       WHERE project_id = $1 AND source_type = 'scrivener' AND source_id = ANY($2::text[])
       FOR UPDATE`,
      [projectId, [...new Set(snapshots.map((s) => s.uuid))]]
    );
    const byUuid = new Map(docs.rows.map((d) => [d.source_id, d]));
    const additions = new Map<string, Record<string, string>>();
    let stored = 0;
    let skipped = 0;
    for (const snap of snapshots) {
      const doc = byUuid.get(snap.uuid);
      const takenAt = new Date(snap.takenAt).toISOString();
      const pending = doc ? additions.get(doc.id) : undefined;
      if (!doc || takenAt in doc.snapshot_index || (pending && takenAt in pending)) {
        skipped++;
        continue;
      }
      // Curly quotes and dashes from older watchers arrive as control characters.
      await client.query(
        `INSERT INTO draft_snapshots (document_id, content, word_count, trigger, created_at)
         VALUES ($1, $2, $3, 'manual', $4)`,
        [doc.id, decodeCp1252Controls(snap.content), snap.wordCount, takenAt]
      );
      const entries = pending ?? {};
      entries[takenAt] = snap.title.trim() || 'Untitled Snapshot';
      additions.set(doc.id, entries);
      stored++;
    }
    for (const [docId, entries] of additions) {
      await client.query(
        `UPDATE corpus_documents
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{scrivenerSnapshots}', ${INDEX_SQL} || $2::jsonb)
         WHERE id = $1`,
        [docId, JSON.stringify(entries)]
      );
    }
    await client.query('COMMIT');
    return { stored, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
