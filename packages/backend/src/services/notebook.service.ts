/**
 * Quinn's Notebook
 *
 * Quinn's long-term memory of working with the writer on a project: how they
 * like to be coached, decisions they've made, open threads, notes on
 * individual pieces, patterns in the writing, and breakthroughs. Session
 * Memory holds only the last few session summaries; the notebook holds what
 * should still matter months later. It goes in the cached part of every
 * coaching prompt.
 *
 * After a session ends, a model reads the transcript and the current notebook
 * and returns edits (add, update, remove), which are validated and applied
 * here. The first update for a project also reads back through recent past
 * sessions. Sessions are folded in oldest first and tracked by a watermark, so
 * an update that fails is retried by the hourly session-closer job.
 *
 * Storage is migration-free, like workflow state: each version of the notebook
 * is a system message (prefixed with NOTEBOOK_MARKER) in the session it was
 * updated from, and the latest version for the project wins. System messages
 * never reach the model as conversation and are hidden in the UI.
 */
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { query, getClient } from '../db/connection.js';
import { config } from '../config.js';
import { sendMessage } from './claude-api.service.js';
import { logApiUsage } from './usage-tracking.service.js';
import { loadPieceIndex, resolvePiece, type PieceIndex } from './piece-index.service.js';

export { loadPieceIndex, type PieceIndex };

const NOTEBOOK_MARKER = '[[QUINN_NOTEBOOK]]';

/** Older versions beyond this many are deleted. */
const VERSIONS_KEPT = 30;

/** The first notebook for a project reads back through this many recent sessions... */
const BOOTSTRAP_SESSIONS = 12;
/** ...or fewer, if their transcripts add up to more than this many characters. */
const BOOTSTRAP_CHAR_BUDGET = 600_000;

/** Long transcripts keep their opening and their last part. */
const TRANSCRIPT_CHAR_CAP = 150_000;
const MAX_SESSIONS_PER_RUN = 12;
/** A session whose update keeps failing is skipped after this many tries. */
const MAX_ATTEMPTS = 3;

const ENTRY_MAX_CHARS = 500;
const PER_PIECE_LIMIT = 4;

export const NOTEBOOK_KINDS = ['preference', 'decision', 'thread', 'piece', 'pattern', 'growth'] as const;
export type NotebookKind = (typeof NOTEBOOK_KINDS)[number];

const KIND_LIMITS: Record<NotebookKind, number> = {
  preference: 12,
  decision: 30,
  thread: 15,
  piece: 60,
  pattern: 15,
  growth: 12,
};

/** Section titles in Quinn's prompt. */
const PROMPT_SECTION_TITLES: Record<NotebookKind, string> = {
  preference: 'How the writer likes to be coached',
  decision: 'Decisions the writer has made',
  thread: 'Open threads',
  piece: 'Notes on pieces',
  pattern: 'Patterns in the writing',
  growth: 'Breakthroughs worth remembering',
};

/** Section titles when the writer reads the notebook with /notebook. */
const WRITER_SECTION_TITLES: Record<NotebookKind, string> = {
  preference: 'How you like to be coached',
  decision: "Decisions you've made",
  thread: 'Open threads',
  piece: 'Notes on pieces',
  pattern: 'Patterns in your writing',
  growth: 'Breakthroughs worth remembering',
};

export interface NotebookEntry {
  /** Short, stable id ("n12") the writer can use with /forget. */
  id: string;
  kind: NotebookKind;
  text: string;
  /** corpus_documents.id of the piece the entry is about, when resolved. */
  pieceId: string | null;
  /** The piece's title when the entry was written; shown if the piece is gone. */
  pieceTitle: string | null;
  /** Writer-local date (YYYY-MM-DD) of the session that last revised the entry. */
  date: string;
}

export interface Notebook {
  version: 1;
  nextId: number;
  /** The last ended session folded in. Sessions that ended after it are pending. */
  through: { sessionId: string; endedAt: string } | null;
  entries: NotebookEntry[];
}

const entrySchema = z.object({
  id: z.string().regex(/^n\d+$/),
  kind: z.enum(NOTEBOOK_KINDS),
  text: z.string().min(1),
  pieceId: z.string().nullable(),
  pieceTitle: z.string().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const notebookSchema = z.object({
  version: z.literal(1),
  nextId: z.number().int().positive(),
  through: z.object({ sessionId: z.string(), endedAt: z.string() }).nullable(),
  entries: z.array(z.unknown()),
});

const emptyNotebook = (): Notebook => ({ version: 1, nextId: 1, through: null, entries: [] });

const idNumber = (id: string): number => Number(id.slice(1));

// ─── Storage ─────────────────────────────────────────────────────────────────

type Queryable = Pick<PoolClient, 'query'>;

function parseNotebook(json: string): Notebook | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const top = notebookSchema.safeParse(raw);
  if (!top.success) return null;
  const entries: NotebookEntry[] = [];
  for (const candidate of top.data.entries) {
    const entry = entrySchema.safeParse(candidate);
    if (entry.success) entries.push(entry.data);
  }
  return { version: 1, nextId: top.data.nextId, through: top.data.through, entries };
}

/** The project's latest readable notebook version, or null if it has none. */
async function loadLatest(projectId: string, db?: Queryable): Promise<Notebook | null> {
  const sql = `SELECT m.content
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE s.project_id = $1 AND m.role = 'system' AND starts_with(m.content, $2)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 5`;
  const params = [projectId, NOTEBOOK_MARKER];
  const result = db
    ? await db.query<{ content: string }>(sql, params)
    : await query<{ content: string }>(sql, params);
  // Fall back past a damaged version rather than starting over.
  for (const row of result.rows) {
    const notebook = parseNotebook(row.content.slice(NOTEBOOK_MARKER.length));
    if (notebook) return notebook;
  }
  return null;
}

/** Load the project's notebook, or null if it doesn't have one yet. */
export async function loadNotebook(projectId: string): Promise<Notebook | null> {
  return loadLatest(projectId);
}

async function saveVersion(
  db: Queryable,
  projectId: string,
  sessionId: string,
  notebook: Notebook
): Promise<void> {
  // clock_timestamp(), not the column default now(): now() is the start of the
  // transaction, which can be earlier than a version another transaction saved
  // while this one waited for the lock.
  await db.query(
    `INSERT INTO messages (session_id, role, content, created_at)
     VALUES ($1, 'system', $2, clock_timestamp())`,
    [sessionId, NOTEBOOK_MARKER + JSON.stringify(notebook)]
  );
  await db.query(
    `DELETE FROM messages WHERE id IN (
       SELECT m.id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE s.project_id = $1 AND m.role = 'system' AND starts_with(m.content, $2)
       ORDER BY m.created_at DESC, m.id DESC
       OFFSET $3
     )`,
    [projectId, NOTEBOOK_MARKER, VERSIONS_KEPT]
  );
}

/**
 * Read, change, and save the notebook under a per-project lock, so a /forget
 * and an end-of-session update can't overwrite each other. `mutate` gets the
 * latest version (or null) and returns the new one, or null to leave it alone.
 */
async function mutateNotebook(
  projectId: string,
  sessionId: string,
  mutate: (current: Notebook | null) => Notebook | null
): Promise<Notebook | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quinn-notebook:${projectId}`]);
    const current = await loadLatest(projectId, client);
    const next = mutate(current);
    if (next) await saveVersion(client, projectId, sessionId, next);
    await client.query('COMMIT');
    return next;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** The writer-local calendar date of a moment, as YYYY-MM-DD. */
function writerDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.WRITER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** "2026-10-12" → "Oct 12, 2026". Fixed locale and zone, so prompt text is stable. */
function formatEntryDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

interface PieceGroup {
  title: string;
  note: string | null;
  order: number;
  entries: NotebookEntry[];
}

/** Piece notes grouped by piece, in binder order. */
function groupByPiece(entries: NotebookEntry[], index: PieceIndex | null): PieceGroup[] {
  const groups = new Map<string, PieceGroup>();
  for (const entry of entries) {
    const info = entry.pieceId ? index?.byId.get(entry.pieceId) : undefined;
    const title = info?.title ?? entry.pieceTitle ?? 'Unnamed piece';
    const key = info ? info.id : `title:${title.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      let note: string | null = null;
      if (info) {
        if (index?.hasBook && !info.inBook) {
          note = `outside the manuscript${info.location ? `, in ${info.location}` : ''}`;
        }
      } else if (index) {
        note = entry.pieceId ? 'no longer in the binder' : 'not found in the binder';
      }
      group = { title, note, order: info?.order ?? Number.MAX_SAFE_INTEGER, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].sort(
    (a, b) => a.order - b.order || a.title.localeCompare(b.title, 'en')
  );
}

const byId = (a: NotebookEntry, b: NotebookEntry): number => idNumber(a.id) - idNumber(b.id);

/**
 * The notebook as a section of Quinn's coaching prompt, or null when it's
 * empty. Deterministic: it sits in the cached prompt.
 */
export function renderNotebookForPrompt(
  notebook: Notebook | null,
  index: PieceIndex | null
): string | null {
  if (!notebook || notebook.entries.length === 0) return null;
  const lines: string[] = [
    "## Quinn's Notebook",
    "Your own notes from working with this writer on this project, kept across sessions and revised after each one. Dates show when a note was last revised. Use them to pick up where things stand: honor the writer's decisions, come back to open threads when the moment is right, and remember what they've said about each piece. If the writer says something that contradicts a note, believe the writer; the notebook is updated after the session. The writer can read the notebook with /notebook and remove a note with /forget.",
  ];
  for (const kind of NOTEBOOK_KINDS) {
    const entries = notebook.entries.filter((e) => e.kind === kind).sort(byId);
    if (entries.length === 0) continue;
    lines.push('', `### ${PROMPT_SECTION_TITLES[kind]}`);
    if (kind === 'piece') {
      for (const group of groupByPiece(entries, index)) {
        lines.push(`${group.title}${group.note ? ` (${group.note})` : ''}:`);
        for (const e of group.entries) lines.push(`- ${e.text} (${formatEntryDate(e.date)})`);
      }
    } else {
      for (const e of entries) lines.push(`- ${e.text} (${formatEntryDate(e.date)})`);
    }
  }
  return lines.join('\n');
}

/** The notebook as the writer sees it with /notebook: plain text, with note ids. */
export function renderNotebookForWriter(notebook: Notebook, index: PieceIndex | null): string {
  const lines: string[] = [
    "Quinn's notebook for this project: what I keep between sessions. I revise it after each session ends.",
  ];
  for (const kind of NOTEBOOK_KINDS) {
    const entries = notebook.entries.filter((e) => e.kind === kind).sort(byId);
    if (entries.length === 0) continue;
    lines.push('', WRITER_SECTION_TITLES[kind]);
    if (kind === 'piece') {
      for (const group of groupByPiece(entries, index)) {
        lines.push(`  ${group.title}${group.note ? ` (${group.note})` : ''}`);
        for (const e of group.entries) lines.push(`    ${e.id}  ${e.text} (${formatEntryDate(e.date)})`);
      }
    } else {
      for (const e of entries) lines.push(`  ${e.id}  ${e.text} (${formatEntryDate(e.date)})`);
    }
  }
  lines.push(
    '',
    "Remove a note with /forget and its number, e.g. /forget n3 (several at once: /forget n3 n7). To change a note, tell me in conversation; I'll revise the notebook when the session ends."
  );
  return lines.join('\n');
}

/** The notebook as the update model sees it: every entry with its id and kind. */
function renderNotebookForUpdate(notebook: Notebook, index: PieceIndex): string {
  if (notebook.entries.length === 0) return '(empty)';
  const lines: string[] = [];
  for (const kind of NOTEBOOK_KINDS) {
    const entries = notebook.entries.filter((e) => e.kind === kind).sort(byId);
    if (entries.length === 0) continue;
    lines.push(`${kind}:`);
    for (const e of entries) {
      const title = e.pieceId ? index.byId.get(e.pieceId)?.title ?? e.pieceTitle : e.pieceTitle;
      const piece = kind === 'piece' && title ? ` [${title}]` : '';
      lines.push(`  ${e.id}${piece} ${e.text} (${e.date})`);
    }
  }
  return lines.join('\n');
}

function renderPieceList(index: PieceIndex): string {
  if (index.pieces.length === 0) return '(none)';
  const shown = index.pieces.slice(0, 400);
  const lines = shown.map((p) => `- ${p.title}${p.location ? ` (${p.location})` : ''}`);
  if (index.pieces.length > shown.length) {
    lines.push(`(and ${index.pieces.length - shown.length} more)`);
  }
  return lines.join('\n');
}

/** The most recent open threads, for Quinn's session opener. */
export function openThreads(notebook: Notebook | null, limit = 5): string[] {
  if (!notebook) return [];
  return notebook.entries
    .filter((e) => e.kind === 'thread')
    .sort((a, b) => b.date.localeCompare(a.date) || idNumber(b.id) - idNumber(a.id))
    .slice(0, limit)
    .map((e) => e.text);
}

// ─── Edits ───────────────────────────────────────────────────────────────────

interface NotebookEdits {
  add: Array<{ kind: NotebookKind; text: string; piece: string | null }>;
  update: Array<{ id: string; text: string }>;
  remove: string[];
}

const addSchema = z.object({
  kind: z.enum(NOTEBOOK_KINDS),
  text: z.string(),
  piece: z.string().nullable().optional(),
});
const updateSchema = z.object({ id: z.string(), text: z.string() });

function extractJSON(content: string): string {
  const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return content;
}

/** Parse the model's edits, dropping malformed items. Null if it isn't a JSON object. */
function parseEdits(content: string): NotebookEdits | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJSON(content));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const add: NotebookEdits['add'] = [];
  for (const item of list(obj.add)) {
    const parsed = addSchema.safeParse(item);
    if (parsed.success) add.push({ kind: parsed.data.kind, text: parsed.data.text, piece: parsed.data.piece ?? null });
  }
  const update: NotebookEdits['update'] = [];
  for (const item of list(obj.update)) {
    const parsed = updateSchema.safeParse(item);
    if (parsed.success) update.push(parsed.data);
  }
  const remove = list(obj.remove).filter((id): id is string => typeof id === 'string');
  return { add: add.slice(0, 40), update: update.slice(0, 60), remove: remove.slice(0, 100) };
}

function cleanText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ENTRY_MAX_CHARS ? `${flat.slice(0, ENTRY_MAX_CHARS - 1).trimEnd()}…` : flat;
}

/** Keep each kind, and each piece, within its limit, dropping the oldest notes. */
function enforceLimits(entries: NotebookEntry[]): NotebookEntry[] {
  const newestFirst = [...entries].sort(
    (a, b) => b.date.localeCompare(a.date) || idNumber(b.id) - idNumber(a.id)
  );
  const keep = new Set<string>();
  const perKind = new Map<NotebookKind, number>();
  const perPiece = new Map<string, number>();
  for (const e of newestFirst) {
    const kindCount = perKind.get(e.kind) ?? 0;
    if (kindCount >= KIND_LIMITS[e.kind]) continue;
    if (e.kind === 'piece') {
      const pieceKey = e.pieceId ?? `title:${(e.pieceTitle ?? '').toLowerCase()}`;
      const pieceCount = perPiece.get(pieceKey) ?? 0;
      if (pieceCount >= PER_PIECE_LIMIT) continue;
      perPiece.set(pieceKey, pieceCount + 1);
    }
    perKind.set(e.kind, kindCount + 1);
    keep.add(e.id);
  }
  return entries.filter((e) => keep.has(e.id));
}

/** Apply edits to a notebook. `date` is the writer-local date of the session. */
function applyEdits(
  notebook: Notebook,
  edits: NotebookEdits,
  date: string,
  index: PieceIndex
): { notebook: Notebook; changes: number; trimmed: number } {
  const removeIds = new Set(edits.remove.map((id) => id.trim().toLowerCase()));
  let entries = notebook.entries.filter((e) => !removeIds.has(e.id));
  let changes = notebook.entries.length - entries.length;

  const updates = new Map(edits.update.map((u) => [u.id.trim().toLowerCase(), cleanText(u.text)]));
  entries = entries.map((e) => {
    const text = updates.get(e.id);
    if (!text || text === e.text) return e;
    changes++;
    return { ...e, text, date };
  });

  let nextId = notebook.nextId;
  const seen = new Set(entries.map((e) => `${e.kind}|${e.text.toLowerCase()}`));
  for (const a of edits.add) {
    const text = cleanText(a.text);
    const key = `${a.kind}|${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    const pieceTitle = a.piece?.trim() || null;
    const piece = pieceTitle ? resolvePiece(index, pieceTitle) : null;
    entries.push({
      id: `n${nextId++}`,
      kind: a.kind,
      text,
      pieceId: piece?.id ?? null,
      pieceTitle: piece?.title ?? pieceTitle,
      date,
    });
    changes++;
  }

  const limited = enforceLimits(entries);
  return {
    notebook: { ...notebook, nextId, entries: limited },
    changes,
    trimmed: entries.length - limited.length,
  };
}

// ─── Updating from sessions ──────────────────────────────────────────────────

interface FoldableSession {
  id: string;
  startedAt: Date;
  /** ended_at as Postgres text: exact to the microsecond, unlike a JS Date. */
  endedAtText: string;
  chars: number;
}

/** Ended sessions after the watermark, oldest first. */
async function findPendingSessions(
  projectId: string,
  through: NonNullable<Notebook['through']>,
  limit: number
): Promise<FoldableSession[]> {
  const result = await query<{ id: string; started_at: Date; ended_at_text: string; chars: number }>(
    `SELECT s.id, s.started_at, s.ended_at::text AS ended_at_text,
            COALESCE(SUM(length(m.content)) FILTER (WHERE m.role IN ('user', 'assistant')), 0)::int AS chars
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.project_id = $1 AND s.ended_at IS NOT NULL
       AND (s.ended_at, s.id) > ($2::timestamptz, $3::uuid)
     GROUP BY s.id
     ORDER BY s.ended_at ASC, s.id ASC
     LIMIT $4`,
    [projectId, through.endedAt, through.sessionId, limit]
  );
  return result.rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    endedAtText: r.ended_at_text,
    chars: r.chars,
  }));
}

/** For a project's first notebook: its most recent sessions within the budget, oldest first. */
async function findBootstrapSessions(projectId: string): Promise<FoldableSession[]> {
  const result = await query<{ id: string; started_at: Date; ended_at_text: string; chars: number }>(
    `SELECT s.id, s.started_at, s.ended_at::text AS ended_at_text,
            COALESCE(SUM(length(m.content)) FILTER (WHERE m.role IN ('user', 'assistant')), 0)::int AS chars
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.project_id = $1 AND s.ended_at IS NOT NULL
     GROUP BY s.id
     ORDER BY s.ended_at DESC, s.id DESC
     LIMIT $2`,
    [projectId, BOOTSTRAP_SESSIONS]
  );
  const chosen: FoldableSession[] = [];
  let budget = BOOTSTRAP_CHAR_BUDGET;
  for (const r of result.rows) {
    const cost = Math.min(r.chars, TRANSCRIPT_CHAR_CAP);
    if (chosen.length > 0 && cost > budget) break;
    budget -= cost;
    chosen.push({ id: r.id, startedAt: r.started_at, endedAtText: r.ended_at_text, chars: r.chars });
  }
  return chosen.reverse();
}

/** Whether any ended session could feed the notebook. */
export async function hasEndedSessions(projectId: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM sessions WHERE project_id = $1 AND ended_at IS NOT NULL LIMIT 1`,
    [projectId]
  );
  return result.rows.length > 0;
}

function buildTranscript(rows: Array<{ role: string; content: string }>): string {
  const text = rows
    .map((m) => `${m.role === 'user' ? 'Writer' : 'Quinn'}: ${m.content.trim()}`)
    .join('\n\n');
  if (text.length <= TRANSCRIPT_CHAR_CAP) return text;
  const head = Math.floor(TRANSCRIPT_CHAR_CAP * 0.2);
  const tail = TRANSCRIPT_CHAR_CAP - head;
  return `${text.slice(0, head)}\n\n[… the middle of this long session is left out …]\n\n${text.slice(text.length - tail)}`;
}

function buildUpdateSystemPrompt(project: { name: string; centralQuestion: string | null }): string {
  const limits = NOTEBOOK_KINDS.map((k) => `${k} ${KIND_LIMITS[k]}`).join(', ');
  return `You keep Quinn's notebook. Quinn is an AI writing coach working with one writer on the project "${project.name}"${project.centralQuestion ? `, whose central question is "${project.centralQuestion}"` : ''}. She coaches and asks questions; the writer writes every word. The notebook is her long-term memory of this work. She reads it at the start of every session, so it should hold what will still matter weeks from now and would change how she coaches.

You'll get the current notebook, the pieces in the writer's binder, and the transcript of one coaching session. Return the edits that bring the notebook up to date with that session.

Kinds of entries:
- preference: how the writer wants to be coached (tone, pace, what helps, what doesn't).
- decision: a call the writer has made about the book or a piece: what's in or out, merges, order, titles, what a piece is for, a rule they've set for themselves. Record Quinn's suggestions only if the writer accepted them.
- thread: something to pick up later: an open question, a revision the writer said they'd try, something Quinn offered to come back to. Remove it once it's resolved.
- piece: something specific about one piece: what the writer said about it, where it stands, what's working, what's unresolved. Set "piece" to its exact title from the list.
- pattern: a habit or strength that shows up across the writing (craft, theme, voice), seen more than once.
- growth: a breakthrough, or a moment the writer trusted their instincts, worth reminding them of later.

Rules:
- Write each entry as one or two plain, specific sentences. Name the piece, the line, the reason. No general praise, and nothing that's obvious from reading the manuscript itself.
- Refer to the writer as "the writer".
- The notebook says what's true now. When the writer changes their mind, update or remove the old entry rather than adding one that contradicts it. Update an existing entry rather than adding a near-duplicate.
- Remove entries this session shows are wrong, resolved, or replaced, and anything the writer asked Quinn to forget. Don't bring back notes the writer removed with /forget.
- This is a notebook about the work. Record personal matters only as far as they bear on the writing or the coaching.
- Stay within these limits per kind, consolidating as you get close: ${limits}; at most ${PER_PIECE_LIMIT} notes per piece.
- Most sessions change a few entries. If nothing in the session will matter later, return empty lists.

Reply with only a JSON object, no other text:
{"add": [{"kind": "decision", "text": "...", "piece": "exact title, or null"}], "update": [{"id": "n12", "text": "..."}], "remove": ["n7"]}`;
}

const inFlight = new Set<string>();
const failedAttempts = new Map<string, number>();

/**
 * Fold one ended session into the notebook. Returns false if it should be
 * retried later (the model call failed or returned something unusable).
 */
async function foldSession(
  userId: string,
  projectId: string,
  project: { name: string; centralQuestion: string | null },
  session: FoldableSession,
  index: PieceIndex
): Promise<boolean> {
  const current = await loadLatest(projectId);
  const base = current ?? emptyNotebook();
  const marker = { sessionId: session.id, endedAt: session.endedAtText };
  const date = writerDateKey(session.startedAt);

  // Save under the lock, unless another run already moved the watermark.
  const save = (edits: NotebookEdits | null): Promise<Notebook | null> =>
    mutateNotebook(projectId, session.id, (latest) => {
      if ((latest?.through?.sessionId ?? null) !== (base.through?.sessionId ?? null)) return null;
      const start = latest ?? emptyNotebook();
      if (!edits) return { ...start, through: marker };
      const applied = applyEdits(start, edits, date, index);
      if (applied.trimmed > 0) {
        console.warn(`[Notebook] Dropped ${applied.trimmed} oldest note(s) to stay within limits (project ${projectId})`);
      }
      return { ...applied.notebook, through: marker };
    });

  const messages = await query<{
    role: string;
    content: string;
    model_used: string | null;
    model_reason: string | null;
  }>(
    `SELECT role, content, model_used, model_reason FROM messages
     WHERE session_id = $1 AND role IN ('user', 'assistant')
     ORDER BY created_at ASC`,
    [session.id]
  );
  // Nothing to learn from a session where the writer only ran commands with
  // fixed replies (/help, /notebook) and Quinn never answered with the model.
  const writerSpoke = messages.rows.some((m) => m.role === 'user' && !m.content.trim().startsWith('/'));
  const quinnReplied = messages.rows.some(
    (m) => m.role === 'assistant' && m.model_used !== null && m.model_reason !== 'Session opener'
  );
  if (!writerSpoke && !quinnReplied) {
    await save(null);
    return true;
  }

  const giveUp = async (reason: string): Promise<boolean> => {
    const attempts = (failedAttempts.get(session.id) ?? 0) + 1;
    failedAttempts.set(session.id, attempts);
    if (attempts < MAX_ATTEMPTS) {
      console.warn(`[Notebook] Update from session ${session.id} failed (${reason}); will retry`);
      return false;
    }
    console.warn(`[Notebook] Skipping session ${session.id} after ${attempts} failed updates (${reason})`);
    failedAttempts.delete(session.id);
    await save(null);
    return true;
  };

  const userContent = [
    `Current notebook:\n${renderNotebookForUpdate(base, index)}`,
    `Pieces in the binder (exact titles, with where they live):\n${renderPieceList(index)}`,
    `Transcript of the coaching session on ${formatEntryDate(date)}:\n\n${buildTranscript(messages.rows)}`,
  ].join('\n\n---\n\n');

  let response;
  try {
    response = await sendMessage({
      systemPrompt: buildUpdateSystemPrompt(project),
      messages: [{ role: 'user', content: userContent }],
      model: 'sonnet',
      // Deciding what's worth remembering is the whole job; give it some thought.
      effort: 'medium',
    });
  } catch (err) {
    return giveUp(err instanceof Error ? err.message : String(err));
  }
  await logApiUsage(userId, response.model, 'notebook', response.inputTokens, response.outputTokens, response.cache);

  const edits = parseEdits(response.content);
  if (!edits) return giveUp('the reply was not a JSON object');
  failedAttempts.delete(session.id);
  await save(edits);
  return true;
}

/**
 * Bring a project's notebook up to date with its ended sessions. The first
 * notebook reads back through recent past sessions. Safe to call often: it
 * returns at once when another update for the project is running or nothing
 * is pending, and never throws.
 */
export async function updateNotebook(projectId: string, userId: string): Promise<void> {
  if (inFlight.has(projectId)) return;
  inFlight.add(projectId);
  try {
    const projectResult = await query<{ name: string; central_question: string | null }>(
      `SELECT name, central_question FROM projects
       WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [projectId, userId]
    );
    const projectRow = projectResult.rows[0];
    if (!projectRow) return;
    const project = { name: projectRow.name, centralQuestion: projectRow.central_question };

    const notebook = await loadLatest(projectId);
    const pending = notebook?.through
      ? await findPendingSessions(projectId, notebook.through, MAX_SESSIONS_PER_RUN)
      : await findBootstrapSessions(projectId);
    if (pending.length === 0) return;

    console.log(
      `[Notebook] Updating project ${projectId} from ${pending.length} session(s)${notebook ? '' : ' (first notebook)'}`
    );
    const index = await loadPieceIndex(projectId);
    for (const session of pending) {
      const done = await foldSession(userId, projectId, project, session, index);
      if (!done) break; // keep the order; the next run picks up from here
    }
  } catch (err) {
    console.warn('[Notebook] Update failed:', err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(projectId);
  }
}

/** Update every active project's notebook. Run hourly by the session closer. */
export async function updatePendingNotebooks(): Promise<void> {
  const projects = await query<{ id: string; user_id: string }>(
    `SELECT p.id, p.user_id
     FROM projects p
     WHERE p.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id AND s.ended_at IS NOT NULL)
     ORDER BY p.created_at, p.id`
  );
  for (const p of projects.rows) {
    await updateNotebook(p.id, p.user_id);
  }
}

// ─── Writer commands ─────────────────────────────────────────────────────────

/** Remove notes by id (/forget). The new version is saved in the current session. */
export async function forgetNotebookEntries(
  projectId: string,
  sessionId: string,
  ids: string[]
): Promise<{ removed: NotebookEntry[]; missing: string[] }> {
  const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  let removed: NotebookEntry[] = [];
  await mutateNotebook(projectId, sessionId, (current) => {
    if (!current) return null;
    removed = current.entries.filter((e) => wanted.includes(e.id));
    if (removed.length === 0) return null;
    return { ...current, entries: current.entries.filter((e) => !wanted.includes(e.id)) };
  });
  const found = new Set(removed.map((e) => e.id));
  return { removed, missing: wanted.filter((id) => !found.has(id)) };
}
