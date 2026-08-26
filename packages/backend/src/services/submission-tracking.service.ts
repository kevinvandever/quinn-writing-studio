/**
 * Submission Tracking / First-Publication Rights
 *
 * Literary journals treat newsletter publication as prior publication, so an
 * essay posted to Substack is usually no longer eligible for the journals that
 * would build the writer's credentials. That mistake is irreversible.
 *
 * Quinn is the only part of the stack that sees BOTH sides of this: the
 * Scrivener binder (every essay) and the Substack corpus (every published post
 * and synced draft). This service lets the writer "earmark" pieces reserved for
 * journal submission and detects when an earmarked piece appears to have been
 * (or is about to be) published on Substack.
 *
 * Migration-free: the earmark lives in `corpus_documents.metadata.submissionStatus`,
 * the same jsonb already used for Scrivener types and per-piece summaries.
 */
import { query } from '../db/connection.js';

export interface EarmarkedPiece {
  id: string;
  title: string;
  wordCount: number;
}

export interface FirstRightsConflict {
  essayTitle: string;
  substackTitle: string;
  matchKind: 'title' | 'content';
}

/**
 * Normalize text for tolerant comparison: lowercase, strip everything that
 * isn't alphanumeric, collapse whitespace. Scrivener text (RTF-derived) and
 * Substack text (HTML-derived) differ in punctuation and spacing, so both sides
 * are normalized the same way before matching.
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** SQL fragment applying the same normalization to a column. */
const SQL_NORMALIZE = `btrim(regexp_replace(lower(%COL%), '[^a-z0-9]+', ' ', 'g'))`;

/**
 * Find a non-folder document in the project whose title matches the given name
 * (exact-insensitive first, then a contains match). Returns null if ambiguous
 * or absent so callers can ask the writer to be more specific.
 */
async function findDocumentByTitle(
  projectId: string,
  title: string
): Promise<{ id: string; title: string } | null> {
  const exact = await query<{ id: string; title: string }>(
    `SELECT id, title FROM corpus_documents
     WHERE project_id = $1 AND is_folder = false AND lower(btrim(title)) = lower(btrim($2))
     LIMIT 2`,
    [projectId, title]
  );
  if (exact.rows.length === 1) return exact.rows[0]!;
  if (exact.rows.length > 1) return null;

  const partial = await query<{ id: string; title: string }>(
    `SELECT id, title FROM corpus_documents
     WHERE project_id = $1 AND is_folder = false AND title ILIKE '%' || btrim($2) || '%'
     ORDER BY length(title) ASC
     LIMIT 2`,
    [projectId, title]
  );
  if (partial.rows.length === 1) return partial.rows[0]!;
  return null;
}

/**
 * Mark (or unmark) a piece as reserved for journal submission.
 * Returns the resolved document title, or null if it couldn't be identified.
 */
export async function setEarmark(
  projectId: string,
  title: string,
  earmarked: boolean
): Promise<string | null> {
  const doc = await findDocumentByTitle(projectId, title);
  if (!doc) return null;

  await query(
    `UPDATE corpus_documents
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [
      doc.id,
      JSON.stringify(
        earmarked
          ? { submissionStatus: 'earmarked', earmarkedAt: new Date().toISOString() }
          : { submissionStatus: null, earmarkedAt: null }
      ),
    ]
  );

  return doc.title;
}

/** List pieces currently earmarked for journal submission. */
export async function loadEarmarkedPieces(projectId: string): Promise<EarmarkedPiece[]> {
  const result = await query<{ id: string; title: string; word_count: number | null }>(
    `SELECT id, title, word_count FROM corpus_documents
     WHERE project_id = $1
       AND is_folder = false
       AND metadata->>'submissionStatus' = 'earmarked'
     ORDER BY title ASC`,
    [projectId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    wordCount: r.word_count ?? 0,
  }));
}

/**
 * Detect earmarked pieces that appear to have been published on Substack —
 * by matching normalized title, or by finding a distinctive passage from the
 * essay inside a Substack document (catches renamed reposts).
 *
 * Substack documents live in the same corpus but usually under a different
 * project, so this checks Substack docs across all of the user's projects.
 */
export async function detectFirstRightsConflicts(
  userId: string,
  projectId: string
): Promise<FirstRightsConflict[]> {
  const earmarked = await query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM corpus_documents
     WHERE project_id = $1
       AND is_folder = false
       AND metadata->>'submissionStatus' = 'earmarked'
     LIMIT 25`,
    [projectId]
  );

  if (earmarked.rows.length === 0) return [];

  const conflicts: FirstRightsConflict[] = [];

  for (const essay of earmarked.rows) {
    const essayTitle = essay.title || 'Untitled';

    // A distinctive passage from the body — skipping the opening, which can be
    // generic — normalized the same way as the SQL side.
    const normalizedBody = normalizeForMatch(essay.content || '');
    const snippet = normalizedBody.length > 400 ? normalizedBody.slice(200, 360) : '';

    const result = await query<{ title: string; match_kind: string }>(
      `SELECT cd.title,
              CASE
                WHEN ${SQL_NORMALIZE.replace('%COL%', 'cd.title')} = $2 THEN 'title'
                ELSE 'content'
              END AS match_kind
       FROM corpus_documents cd
       JOIN projects p ON p.id = cd.project_id
       WHERE p.user_id = $1
         AND cd.source_type = 'substack'
         AND cd.is_folder = false
         AND (
           ${SQL_NORMALIZE.replace('%COL%', 'cd.title')} = $2
           OR (
             $3 <> ''
             AND position($3 in ${SQL_NORMALIZE.replace('%COL%', 'cd.content')}) > 0
           )
         )
       LIMIT 3`,
      [userId, normalizeForMatch(essayTitle), snippet]
    );

    for (const row of result.rows) {
      conflicts.push({
        essayTitle,
        substackTitle: row.title || 'Untitled',
        matchKind: row.match_kind === 'title' ? 'title' : 'content',
      });
    }
  }

  return conflicts;
}

/**
 * Build the system-prompt section for first-publication rights: which pieces are
 * reserved for journals, and any apparent Substack collisions.
 * Returns null when the writer has earmarked nothing (keeps the prompt lean).
 */
export function buildFirstRightsContext(
  earmarked: EarmarkedPiece[],
  conflicts: FirstRightsConflict[]
): string | null {
  if (earmarked.length === 0) return null;

  const lines: string[] = [
    '## First-Publication Rights',
    "These pieces are reserved for literary journal submission. Most journals count newsletter publication as prior publication, so posting one of these to Substack would disqualify it — an irreversible loss. If the writer proposes publishing, excerpting, or newslettering any piece below, flag the rights consequence before anything else, then let them decide. Never suggest one of these as newsletter material yourself.",
    '',
    'Reserved for journal submission:',
    ...earmarked.map((p) => `  - ${p.title} (${p.wordCount.toLocaleString()} words)`),
  ];

  if (conflicts.length > 0) {
    lines.push(
      '',
      'WARNING — these reserved pieces appear to already exist in the Substack corpus. Raise this proactively; the writer may have published them without realizing the cost, or these may be false matches worth confirming:'
    );
    for (const c of conflicts) {
      lines.push(
        `  - "${c.essayTitle}" matches Substack post "${c.substackTitle}" (${
          c.matchKind === 'title' ? 'same title' : 'overlapping text'
        })`
      );
    }
  }

  return lines.join('\n');
}
