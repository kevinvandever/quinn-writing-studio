/**
 * Revision History
 *
 * How pieces have changed, from their stored versions: Scrivener snapshots
 * (see scrivener-snapshots.service.ts) and the text the app saves whenever a
 * sync changes a piece. Versions are compared paragraph by paragraph
 * (utils/paragraph-diff.ts).
 *
 * Feeds two things:
 * - "Manuscript Changes Since Your Last Session": what the writer cut, added,
 *   and rewrote between sessions, in the cached part of every coaching prompt
 *   and in the session opener.
 * - The /revisions mode: one piece's versions over time.
 */
import { query } from '../db/connection.js';
import { config } from '../config.js';
import {
  comparableText,
  countWords,
  describeDiff,
  diffParagraphs,
  renderDiff,
  type ParagraphDiff,
} from '../utils/paragraph-diff.js';
import { findPieceByTitle, loadPieceIndex } from './piece-index.service.js';

const formatNumber = (n: number): string => n.toLocaleString('en-US');

function signed(n: number): string {
  if (n > 0) return `+${formatNumber(n)}`;
  if (n < 0) return `−${formatNumber(-n)}`;
  return '±0';
}

/** "Oct 14, 2026", in the writer's time zone. Fixed locale, so prompt text is stable. */
function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    timeZone: config.WRITER_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const changedChars = (diff: ParagraphDiff): number =>
  diff.hunks.reduce((sum, h) => sum + h.before.join(' ').length + h.after.join(' ').length, 0);

// ─── Changes since the last session ──────────────────────────────────────────

interface ImportDiff {
  added?: Array<{ title: string; uuid?: string }>;
  modified?: Array<{ title: string; uuid?: string; oldWordCount: number; newWordCount: number }>;
  deleted?: Array<{ title: string; uuid?: string }>;
  renamed?: Array<{ uuid: string; oldTitle: string; newTitle: string }>;
  moved?: Array<{ uuid: string; title: string; from: string; to: string }>;
  reordered?: Array<{ uuid: string | null; title: string }>;
}

export interface ChangesBudget {
  /** Characters of changed passages across all pieces. */
  total: number;
  /** Characters of changed passages for any one piece. */
  perPiece: number;
}

/**
 * What changed in the manuscript since the last session ended, with the
 * passages the writer cut, added, or rewrote. Without a previous session, the
 * most recent sync's changes. Null when nothing changed. Deterministic, since
 * it sits in the cached prompt.
 */
export async function loadManuscriptChanges(
  projectId: string,
  budget: ChangesBudget
): Promise<string | null> {
  const lastSession = await query<{ ended_at: Date }>(
    `SELECT ended_at FROM sessions
     WHERE project_id = $1 AND ended_at IS NOT NULL
     ORDER BY ended_at DESC
     LIMIT 1`,
    [projectId]
  );
  const since = lastSession.rows[0]?.ended_at ?? null;

  const imports = await query<{ diff_summary: ImportDiff | null }>(
    since
      ? `SELECT diff_summary FROM scrivener_imports
         WHERE project_id = $1 AND imported_at > $2
         ORDER BY imported_at ASC, id`
      : `SELECT diff_summary FROM scrivener_imports
         WHERE project_id = $1
         ORDER BY imported_at DESC, id
         LIMIT 1`,
    since ? [projectId, since] : [projectId]
  );
  if (imports.rows.length === 0) return null;

  // Combine the imports, keyed by binder UUID (title for old imports without one).
  const added = new Map<string, string>();
  const modified = new Map<string, { title: string; uuid?: string; oldWordCount: number; newWordCount: number }>();
  const deleted = new Map<string, string>();
  // Net renames and moves: first "before", last "after".
  const renamed = new Map<string, { from: string; to: string }>();
  const moved = new Map<string, { title: string; from: string; to: string }>();
  const reordered = new Map<string, string>();
  for (const { diff_summary: diff } of imports.rows) {
    if (!diff) continue;
    for (const r of diff.renamed ?? []) {
      renamed.set(r.uuid, { from: renamed.get(r.uuid)?.from ?? r.oldTitle, to: r.newTitle });
    }
    for (const m of diff.moved ?? []) {
      moved.set(m.uuid, { title: m.title, from: moved.get(m.uuid)?.from ?? m.from, to: m.to });
    }
    for (const r of diff.reordered ?? []) reordered.set(r.uuid ?? '', r.title);
    for (const a of diff.added ?? []) added.set(a.uuid ?? a.title, a.title);
    for (const m of diff.modified ?? []) {
      const key = m.uuid ?? m.title;
      const earlier = modified.get(key);
      modified.set(key, {
        title: m.title,
        uuid: m.uuid,
        oldWordCount: earlier?.oldWordCount ?? m.oldWordCount,
        newWordCount: m.newWordCount,
      });
    }
    for (const d of diff.deleted ?? []) deleted.set(d.uuid ?? d.title, d.title);
  }
  for (const key of added.keys()) modified.delete(key); // new since the session: no "before"
  for (const key of deleted.keys()) modified.delete(key);
  for (const key of [...added.keys()]) {
    if (deleted.has(key)) {
      added.delete(key); // added and removed again in between
      deleted.delete(key);
    }
  }

  // The text as of the last session is the first version saved after it (a
  // sync saves a piece's old text before changing it). Without a session, the
  // version the latest sync saved.
  const uuids = [...modified.values()].map((m) => m.uuid).filter((u): u is string => !!u);
  const texts = new Map<string, { current: string; before: string | null }>();
  if (uuids.length > 0) {
    const rows = await query<{ source_id: string; content: string | null; before: string | null }>(
      `SELECT cd.source_id, cd.content,
              (SELECT ds.content FROM draft_snapshots ds
               WHERE ds.document_id = cd.id AND ds.trigger = 'pre_import_update'
                 AND ($3::timestamptz IS NULL OR ds.created_at > $3)
               ORDER BY ds.created_at ${since ? 'ASC' : 'DESC'}, ds.id
               LIMIT 1) AS before
       FROM corpus_documents cd
       WHERE cd.project_id = $1 AND cd.source_type = 'scrivener' AND cd.source_id = ANY($2::text[])`,
      [projectId, uuids, since]
    );
    for (const r of rows.rows) texts.set(r.source_id, { current: r.content ?? '', before: r.before });
  }

  const revised: Array<{ title: string; words: number; delta: number; diff: ParagraphDiff | null; size: number }> = [];
  for (const m of modified.values()) {
    const text = m.uuid ? texts.get(m.uuid) : undefined;
    const diff = text && text.before !== null ? diffParagraphs(text.before, text.current) : null;
    if (diff && diff.hunks.length === 0) continue; // changed and changed back
    const delta = diff ? diff.wordDelta : m.newWordCount - m.oldWordCount;
    revised.push({
      title: m.title,
      words: m.newWordCount,
      delta,
      diff,
      size: diff ? changedChars(diff) : Math.abs(delta) * 6,
    });
  }
  // Biggest changes first.
  revised.sort((a, b) => b.size - a.size || a.title.localeCompare(b.title, 'en'));

  // Drop renames and moves that ended where they started, and anything about
  // pieces that came or went entirely.
  for (const [key, r] of renamed) if (r.from === r.to || added.has(key) || deleted.has(key)) renamed.delete(key);
  for (const [key, m] of moved) if (m.from === m.to || added.has(key) || deleted.has(key)) moved.delete(key);
  const renamedLines = [...renamed.values()]
    .map((r) => `"${r.from}" is now "${r.to}"`)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const movedLines = [...moved.values()]
    .map((m) => `${m.title}: from ${m.from} to ${m.to}`)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const reorderedTitles = [...reordered.values()].sort((a, b) => a.localeCompare(b, 'en'));

  if (
    added.size === 0 &&
    deleted.size === 0 &&
    revised.length === 0 &&
    renamedLines.length === 0 &&
    movedLines.length === 0 &&
    reorderedTitles.length === 0
  ) {
    return null;
  }

  const lines: string[] = [
    since
      ? `## Manuscript Changes Since Your Last Session\nThe writer has worked in Scrivener since your last session ended (${formatDay(since)}). The Manuscript section has the current text; this is what changed. Quoted passages are the writer's own words.`
      : "## Recent Manuscript Changes\nWhat changed in the writer's most recent Scrivener sync. The Manuscript section has the current text. Quoted passages are the writer's own words.",
  ];
  const sortedTitles = (m: Map<string, string>): string[] =>
    [...m.values()].sort((a, b) => a.localeCompare(b, 'en'));
  if (added.size > 0) lines.push('', `New pieces: ${sortedTitles(added).join('; ')}`);
  if (deleted.size > 0) lines.push('', `Removed from the binder: ${sortedTitles(deleted).join('; ')}`);
  if (movedLines.length > 0) lines.push('', `Moved:\n${movedLines.map((l) => `- ${l}`).join('\n')}`);
  if (renamedLines.length > 0) lines.push('', `Renamed:\n${renamedLines.map((l) => `- ${l}`).join('\n')}`);
  if (reorderedTitles.length > 0) lines.push('', `Pieces put in a new order within: ${reorderedTitles.join('; ')}`);
  if (revised.length > 0) {
    lines.push('', 'Revised:');
    let used = 0;
    const leftOut: string[] = [];
    for (const r of revised) {
      if (used >= budget.total) {
        leftOut.push(`${r.title} (${signed(r.delta)} words)`);
        continue;
      }
      const head = `### ${r.title} (${signed(r.delta)} words, now ${formatNumber(r.words)}${r.diff ? `; ${describeDiff(r.diff)}` : ''})`;
      const body = r.diff
        ? renderDiff(r.diff, Math.min(budget.perPiece, budget.total - used))
        : '(The earlier text isn\'t stored, so only the word count is known.)';
      lines.push(head, body);
      used += head.length + body.length;
    }
    if (leftOut.length > 0) lines.push(`Also revised (passages left out for length): ${leftOut.join('; ')}`);
  }
  return lines.join('\n');
}

// ─── One piece's history (/revisions) ────────────────────────────────────────

const FIRST_VERSION_CHARS = 30_000;
const STEP_DIFF_CHARS = 3_000;
const RECENT_STEPS = 3;
const TIMELINE_MAX = 40;

interface Version {
  /** null for the current text. */
  at: Date | null;
  label: string;
  content: string;
  words: number;
}

/** A piece's stored versions, oldest first, without consecutive repeats. */
async function loadVersions(documentId: string): Promise<Version[]> {
  const result = await query<{
    content: string;
    word_count: number | null;
    trigger: string;
    created_at: Date;
    snapshot_index: Record<string, string>;
  }>(
    `SELECT ds.content, ds.word_count, ds.trigger, ds.created_at,
            CASE WHEN jsonb_typeof(cd.metadata->'scrivenerSnapshots') = 'object'
                 THEN cd.metadata->'scrivenerSnapshots' ELSE '{}'::jsonb END AS snapshot_index
     FROM draft_snapshots ds
     JOIN corpus_documents cd ON cd.id = ds.document_id
     WHERE ds.document_id = $1
     ORDER BY ds.created_at ASC, ds.id`,
    [documentId]
  );
  const versions: Version[] = [];
  let previous: string | null = null;
  for (const row of result.rows) {
    // Versions that differ only in extraction debris (comment links) are one version.
    const comparable = comparableText(row.content);
    if (!comparable || comparable === previous) continue;
    previous = comparable;
    const scrivenerTitle =
      row.trigger === 'manual' ? row.snapshot_index[row.created_at.toISOString()] : undefined;
    const label =
      scrivenerTitle !== undefined
        ? `Scrivener snapshot "${scrivenerTitle}"`
        : row.trigger === 'manual'
          ? 'version saved in the app'
          : "the text before that day's sync changed it";
    versions.push({ at: row.created_at, label, content: row.content, words: countWords(comparable) });
  }
  return versions;
}

/**
 * A piece's versions over time and what changed in its latest revisions, plus
 * (by default) its earliest version in full. Used by the /revisions mode and
 * by Quinn's piece_history tool.
 */
export async function buildRevisionHistoryContext(
  projectId: string,
  pieceTitle: string | null,
  options: { includeEarliest: boolean } = { includeEarliest: true }
): Promise<string> {
  if (!pieceTitle) {
    return "## Revision History\nThe writer didn't name a piece. Ask which piece they mean.";
  }
  const index = await loadPieceIndex(projectId);
  const piece = findPieceByTitle(index, pieceTitle);
  if (!piece) {
    return `## Revision History\nNo piece titled "${pieceTitle}" is in the binder (Trash isn't searched). Ask the writer for the exact title.`;
  }

  const doc = await query<{ content: string | null }>(
    `SELECT content FROM corpus_documents WHERE id = $1`,
    [piece.id]
  );
  const current = doc.rows[0]?.content ?? '';
  const stored = await loadVersions(piece.id);
  const header = `## Revision History: "${piece.title}"`;
  const where = piece.location
    ? `It lives in ${piece.location}${index.hasBook ? (piece.inBook ? ' (in the manuscript)' : ' (outside the manuscript)') : ''}.`
    : '';
  if (stored.length === 0) {
    const none =
      'No earlier versions of this piece are stored. Versions come from Scrivener snapshots and from syncs that change the piece, so there may be some next time.';
    return `${header}\n${[where, none].filter(Boolean).join(' ')}`;
  }

  const steps: Version[] = [...stored];
  if (current.trim() && comparableText(stored[stored.length - 1]!.content) !== comparableText(current)) {
    steps.push({
      at: null,
      label: 'the current text',
      content: current,
      words: countWords(comparableText(current)),
    });
  }
  const diffs: Array<ParagraphDiff | null> = steps.map((step, i) =>
    i === 0 ? null : diffParagraphs(steps[i - 1]!.content, step.content)
  );
  const day = (v: Version): string => (v.at ? formatDay(v.at) : 'Now');

  const lines: string[] = [
    header,
    `${where} ${stored.length} earlier version${stored.length === 1 ? ' is' : 's are'} stored, from ${formatDay(stored[0]!.at!)} on. A Scrivener snapshot is a version saved in Scrivener; "Pre-Sync External File Version" snapshots are ones Scrivener took automatically before syncing with an external folder. The current text is in The Manuscript section if the piece is in the book; otherwise it's in the retrieved material, or read it with read_document.`.trim(),
    '',
    'Versions, oldest first:',
  ];
  const timeline = steps.map((step, i) => {
    const diff = diffs[i];
    const change = diff ? ` · ${signed(diff.wordDelta)} words; ${describeDiff(diff)}` : '';
    return `${i + 1}. ${day(step)} · ${step.label} · ${formatNumber(step.words)} words${change}`;
  });
  if (timeline.length > TIMELINE_MAX) {
    const head = timeline.slice(0, 5);
    const tail = timeline.slice(timeline.length - (TIMELINE_MAX - 5));
    lines.push(...head, `(${timeline.length - head.length - tail.length} versions in between left out)`, ...tail);
  } else {
    lines.push(...timeline);
  }

  const first = steps[0]!;
  if (options.includeEarliest) {
    const firstClean = comparableText(first.content);
    const firstText =
      firstClean.length > FIRST_VERSION_CHARS
        ? `${firstClean.slice(0, FIRST_VERSION_CHARS)}\n(The rest of this version, ${formatNumber(firstClean.length - FIRST_VERSION_CHARS)} characters, is left out.)`
        : firstClean;
    lines.push('', `The earliest stored version (${day(first)}), in full:`, '<earliest_version>', firstText.trim(), '</earliest_version>');
  } else {
    lines.push('', `(The earliest version, from ${day(first)}, isn't included here. Ask for it with include_earliest_text if you need its full text.)`);
  }

  const recent: string[] = [];
  for (let i = steps.length - 1; i > 0 && recent.length < RECENT_STEPS; i--) {
    const diff = diffs[i];
    if (!diff || diff.hunks.length === 0) continue;
    recent.push(`### ${day(steps[i - 1]!)} → ${day(steps[i]!)}\n${renderDiff(diff, STEP_DIFF_CHARS)}`);
  }
  if (recent.length > 0) lines.push('', 'The latest revisions, newest first:', ...recent);
  return lines.join('\n');
}
