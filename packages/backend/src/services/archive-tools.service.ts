/**
 * Archive Tools
 *
 * Tools Quinn can call during a coaching turn to look up what isn't in her
 * prompt: the writer's other writing (binder folders outside the manuscript,
 * Substack posts, uploads, other projects, quick captures, and Trash on
 * request), past coaching conversations, and earlier versions of a piece.
 *
 * Every query is scoped to the writer's user id. Tool inputs come from the
 * model, so they're checked here and only ever passed as query parameters.
 *
 * ARCHIVE_TOOLS and ARCHIVE_TOOLS_GUIDE are part of the cached prompt prefix,
 * so they must stay byte-identical between requests.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/connection.js';
import { formatWriterShortDate } from '../utils/time.js';
import { cleanForReading, cleanPassage } from '../utils/paragraph-diff.js';
import { normalizeTitle } from './piece-index.service.js';
import { buildRevisionHistoryContext } from './revision-history.service.js';

// ─── Definitions ─────────────────────────────────────────────────────────────

export const ARCHIVE_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'search_writing',
    description:
      'Search everything the writer has synced, across all of their projects: the manuscript, salvage and other binder folders, research and notes, Substack posts, uploaded documents, and quick captures. Matching is by words, not meaning (stemmed, so "fathers" finds "father"), so try names, distinctive words, and a few phrasings. Put a phrase in double quotes to match it exactly. Results come best first, each with its id, where it lives, and a few matching passages. Trash (deleted work) and dismissed captures are left out unless include_trash is true.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for. Put an exact phrase in double quotes.',
        },
        include_trash: {
          type: 'boolean',
          description: 'Also search Trash and dismissed captures. Default false.',
        },
        limit: {
          type: 'integer',
          description: 'How many results to return, 1 to 15. Default 8.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_document',
    description:
      "Read a document in full: anything search_writing found (pass its id), or a piece by its exact title. The manuscript is already in your prompt, so don't use this for pieces in it. Long documents come in parts; pass part to read further.",
    input_schema: {
      type: 'object',
      properties: {
        document: {
          type: 'string',
          description: 'The id from search_writing, or the exact title of a piece.',
        },
        part: {
          type: 'integer',
          description: 'Which part of a long document to read, starting at 1. Default 1.',
        },
      },
      required: ['document'],
    },
  },
  {
    name: 'search_conversations',
    description:
      "Search your past coaching conversations with the writer, in all of their projects and including earlier in this session, for something either of you said. Matching is by words, not meaning. Returns the matching exchanges with their dates. Use it when the writer refers to an earlier conversation, and before telling them you don't remember something.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for. Put an exact phrase in double quotes.',
        },
        limit: {
          type: 'integer',
          description: 'How many conversations to return, 1 to 10. Default 5.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'piece_history',
    description:
      'See how a piece in this project has changed: its saved versions over time (Scrivener snapshots, and the text saved whenever a sync changed it), with what was cut, added, or rewritten at each step. Set include_earliest_text to also get the earliest version in full.',
    input_schema: {
      type: 'object',
      properties: {
        piece: {
          type: 'string',
          description: 'The title of the piece.',
        },
        include_earliest_text: {
          type: 'boolean',
          description: 'Also return the earliest stored version in full. Default false.',
        },
      },
      required: ['piece'],
    },
  },
];

/** How Quinn should use the tools. Goes in the cached system prompt. */
export const ARCHIVE_TOOLS_GUIDE = `## Looking Things Up
You have tools for what isn't in front of you: search_writing and read_document for the writer's other writing (salvage, notes, research, Substack posts, other projects, quick captures, and Trash when asked), search_conversations for your past conversations with them, and piece_history for earlier versions of a piece in this project. The manuscript is already here in full, so don't use a tool to read it.

Most turns don't need a tool. Reach for one when the writer mentions writing or a conversation you can't see ("I wrote about this somewhere", "what did we decide about the ending?"), when material elsewhere might serve the piece you're discussing, or before you tell them you don't remember something. Search matches words, not meaning: if a search comes up empty, try other words, a name, or a quoted phrase before giving up.

The app shows the writer a short note while you look, so don't announce your searches. In your reply, say where things came from (the piece and its folder, or the date of the conversation), and say plainly when you looked and found nothing. Anything from Trash is deleted work; say so when you bring it up. Quote only to point at a passage.`;

// ─── Context and results ─────────────────────────────────────────────────────

export interface ArchiveToolContext {
  userId: string;
  /** The project of the current session. */
  projectId: string;
  sessionId: string;
  /** Documents whose full text is already in the prompt. */
  inPrompt: Set<string>;
  /**
   * Messages of the current session from this time on are in the request
   * already, so conversation search leaves them out.
   */
  visibleSince: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 15;
const CONVERSATION_LIMIT_DEFAULT = 5;
const CONVERSATION_LIMIT_MAX = 10;
/** Characters per part when reading a long document. */
const PART_CHARS = 30_000;
const SNIPPET_CHARS = 600;
const QUERY_MAX_CHARS = 300;

const formatNumber = (n: number): string => n.toLocaleString('en-US');

/** Read a field of the model's input object, whatever shape it sent. */
function field(input: unknown, name: string): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;
}

function text(input: unknown, name: string): string | null {
  const value = field(input, name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, QUERY_MAX_CHARS) : null;
}

function int(input: unknown, name: string, min: number, max: number, fallback: number): number {
  const value = Number(field(input, name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function flag(input: unknown, name: string): boolean {
  const value = field(input, name);
  return value === true || value === 'true';
}

/**
 * The same search, with its words OR-ed instead of AND-ed, so documents that
 * have only some of the words still turn up (after the ones that have all).
 */
function anyWordsQuery(q: string): string {
  const tokens = q.match(/"[^"]*"|[^\s"]+/g) ?? [];
  return tokens
    .filter((t) => !/^(or|and)$/i.test(t) && !t.startsWith('-'))
    .join(' or ');
}

/** Whether the search has any words Postgres will look for (not all stop words). */
async function hasSearchableWords(q: string): Promise<boolean> {
  const result = await query<{ n: number }>(
    `SELECT numnode(websearch_to_tsquery('english', $1)) AS n`,
    [q]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// ─── The writer's library ────────────────────────────────────────────────────

export type Area = 'book' | 'binder' | 'trash' | 'other';

export interface DocInfo {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  sourceType: string;
  area: Area;
  /** Binder folders above the document, e.g. "SALVAGE - Good Material to Mine". */
  path: string;
  wordCount: number;
  updatedAt: Date;
  publishedAt: string | null;
  /** Depth-first binder position within the project, for stable ordering. */
  order: number;
}

/** Every document in the writer's active projects, with where it lives (no text). */
export async function loadLibrary(userId: string): Promise<Map<string, DocInfo>> {
  const result = await query<{
    id: string;
    parent_id: string | null;
    title: string | null;
    is_folder: boolean;
    source_type: string;
    word_count: number | null;
    sort_order: number | null;
    updated_at: Date;
    scrivener_type: string | null;
    published_at: string | null;
    project_id: string;
    project_name: string;
  }>(
    `SELECT cd.id, cd.parent_id, cd.title, cd.is_folder, cd.source_type, cd.word_count,
            cd.sort_order, cd.updated_at,
            cd.metadata->>'scrivenerType' AS scrivener_type,
            cd.metadata->>'published_at' AS published_at,
            p.id AS project_id, p.name AS project_name
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE p.user_id = $1 AND p.archived_at IS NULL
     ORDER BY p.created_at, p.id, cd.sort_order NULLS LAST, cd.id`,
    [userId]
  );

  interface Node {
    row: (typeof result.rows)[number];
    children: Node[];
  }
  const nodes = new Map<string, Node>();
  for (const row of result.rows) nodes.set(row.id, { row, children: [] });
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.row.parent_id ? nodes.get(node.row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byOrder = (a: Node, b: Node): number =>
    (a.row.sort_order ?? 0) - (b.row.sort_order ?? 0) || (a.row.id < b.row.id ? -1 : 1);
  const title = (n: Node): string => (n.row.title || 'Untitled').trim();
  const isTrash = (n: Node): boolean =>
    n.row.scrivener_type === 'TrashFolder' || (n.row.is_folder && title(n).toLowerCase() === 'trash');
  const isBookRoot = (n: Node): boolean =>
    n.row.scrivener_type === 'DraftFolder' ||
    (n.row.is_folder && ['front matter', 'back matter'].includes(title(n).toLowerCase()));

  const library = new Map<string, DocInfo>();
  let order = 0;
  const walk = (list: Node[], path: string[], area: Area): void => {
    for (const node of [...list].sort(byOrder)) {
      const here: Area = area === 'trash' || isTrash(node) ? 'trash' : area;
      if (!node.row.is_folder) {
        library.set(node.row.id, {
          id: node.row.id,
          title: title(node),
          projectId: node.row.project_id,
          projectName: node.row.project_name,
          sourceType: node.row.source_type,
          area: node.row.source_type === 'scrivener' ? here : 'other',
          path: path.join(' › '),
          wordCount: node.row.word_count ?? 0,
          updatedAt: node.row.updated_at,
          publishedAt: node.row.published_at,
          order: order++,
        });
      }
      walk(node.children, [...path, title(node)], here);
    }
  };
  for (const root of [...roots].sort(byOrder)) {
    if (root.row.is_folder) {
      const area: Area = isTrash(root) ? 'trash' : isBookRoot(root) ? 'book' : 'binder';
      walk(root.children, [title(root)], area);
    } else {
      walk([root], [], 'binder');
    }
  }
  return library;
}

/** Where a document lives, in words, for search results and reading. */
function describeWhere(doc: DocInfo, ctx: ArchiveToolContext): string {
  const otherProject = doc.projectId !== ctx.projectId ? ` (project: ${doc.projectName})` : '';
  switch (doc.area) {
    case 'book':
      if (doc.projectId === ctx.projectId) {
        return ctx.inPrompt.has(doc.id)
          ? `in the manuscript${doc.path ? `, ${doc.path}` : ''} (its full text is already in your prompt)`
          : `in the manuscript${doc.path ? `, ${doc.path}` : ''}`;
      }
      return `in the manuscript of ${doc.projectName}${doc.path ? `, ${doc.path}` : ''}`;
    case 'binder':
      return `${doc.path || 'the top level of the binder'}, outside the manuscript${otherProject}`;
    case 'trash':
      return `in Trash, deleted from the binder${doc.path ? ` (${doc.path})` : ''}${otherProject}`;
    default:
      if (doc.sourceType === 'substack') {
        const published = doc.publishedAt ? new Date(doc.publishedAt) : null;
        const when =
          published && !Number.isNaN(published.getTime())
            ? `, published ${formatWriterShortDate(published)}`
            : '';
        return `a Substack post${when} (project: ${doc.projectName})`;
      }
      return `an uploaded document (project: ${doc.projectName})`;
  }
}

// ─── search_writing ──────────────────────────────────────────────────────────

const HEADLINE_OPTIONS =
  'MaxFragments=3, MaxWords=28, MinWords=10, FragmentDelimiter=" … ", StartSel=«, StopSel=»';

interface Hit {
  kind: 'document' | 'capture';
  id: string;
  allWords: boolean;
  rank: number;
}

async function searchWriting(
  ctx: ArchiveToolContext,
  input: unknown,
  announce: (label: string) => void
): Promise<ToolOutcome> {
  const q = text(input, 'query');
  if (!q) return { content: 'Give search_writing some words to look for.', isError: true };
  const includeTrash = flag(input, 'include_trash');
  const limit = int(input, 'limit', 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  announce(`Searching your writing for “${clip(q, 60)}”${includeTrash ? ', Trash included' : ''}`);

  if (!(await hasSearchableWords(q))) {
    return {
      content: `"${q}" is all common words, which the search skips. Try distinctive words: a name, a place, an object, an unusual phrase.`,
    };
  }
  const anyWords = anyWordsQuery(q) || q;
  const library = await loadLibrary(ctx.userId);
  const excluded = includeTrash
    ? []
    : [...library.values()].filter((d) => d.area === 'trash').map((d) => d.id);

  // Title counts most, then the logline, then the text. Documents with all the
  // words come before those with only some.
  const docs = await query<{ id: string; all_words: boolean; rank: number }>(
    `WITH docs AS MATERIALIZED (
       SELECT cd.id,
              setweight(to_tsvector('english', coalesce(cd.title, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(cd.metadata->>'summary', '')), 'B') ||
              setweight(to_tsvector('english', coalesce(cd.content, '')), 'C') AS vec
       FROM corpus_documents cd
       JOIN projects p ON p.id = cd.project_id
       WHERE p.user_id = $1 AND p.archived_at IS NULL
         AND cd.is_folder = false AND coalesce(cd.content, '') <> ''
         AND NOT (cd.id = ANY($4::uuid[]))
     )
     SELECT d.id, (d.vec @@ qa) AS all_words, ts_rank_cd(d.vec, qo, 1 | 32) AS rank
     FROM docs d, websearch_to_tsquery('english', $2) qa, websearch_to_tsquery('english', $3) qo
     WHERE d.vec @@ qo
     ORDER BY all_words DESC, rank DESC, d.id
     LIMIT $5`,
    [ctx.userId, q, anyWords, excluded, limit]
  );
  const captures = await query<{ id: string; all_words: boolean; rank: number }>(
    `SELECT c.id, (to_tsvector('english', c.content) @@ qa) AS all_words,
            ts_rank_cd(to_tsvector('english', c.content), qo, 1 | 32) AS rank
     FROM quick_captures c, websearch_to_tsquery('english', $2) qa, websearch_to_tsquery('english', $3) qo
     WHERE c.user_id = $1 AND ($4 OR c.status <> 'dismissed')
       AND to_tsvector('english', c.content) @@ qo
     ORDER BY all_words DESC, rank DESC, c.id
     LIMIT $5`,
    [ctx.userId, q, anyWords, includeTrash, limit]
  );

  const hits: Hit[] = [
    ...docs.rows.map((r) => ({ kind: 'document' as const, id: r.id, allWords: r.all_words, rank: Number(r.rank) })),
    ...captures.rows.map((r) => ({ kind: 'capture' as const, id: r.id, allWords: r.all_words, rank: Number(r.rank) })),
  ]
    .sort((a, b) => Number(b.allWords) - Number(a.allWords) || b.rank - a.rank || (a.id < b.id ? -1 : 1))
    .slice(0, limit);

  const scope = includeTrash ? 'everything, Trash included' : 'everything outside Trash';
  if (hits.length === 0) {
    return { content: `No matches for "${q}" (searched ${scope}). Try other words, a name, or a shorter phrase.` };
  }

  const docIds = hits.filter((h) => h.kind === 'document').map((h) => h.id);
  const captureIds = hits.filter((h) => h.kind === 'capture').map((h) => h.id);
  const snippets = new Map<string, string>();
  if (docIds.length > 0) {
    const rows = await query<{ id: string; snippet: string }>(
      `SELECT id, ts_headline('english', content, websearch_to_tsquery('english', $2), $3) AS snippet
       FROM corpus_documents WHERE id = ANY($1::uuid[])`,
      [docIds, anyWords, HEADLINE_OPTIONS]
    );
    for (const r of rows.rows) snippets.set(r.id, r.snippet);
  }
  const captureRows = new Map<string, { content: string; status: string; created_at: Date; project: string | null }>();
  if (captureIds.length > 0) {
    const rows = await query<{ id: string; content: string; status: string; created_at: Date; project: string | null; snippet: string }>(
      `SELECT c.id, c.content, c.status, c.created_at, p.name AS project,
              ts_headline('english', c.content, websearch_to_tsquery('english', $2), $3) AS snippet
       FROM quick_captures c LEFT JOIN projects p ON p.id = c.project_id
       WHERE c.id = ANY($1::uuid[]) AND c.user_id = $4`,
      [captureIds, anyWords, HEADLINE_OPTIONS, ctx.userId]
    );
    for (const r of rows.rows) {
      captureRows.set(r.id, r);
      snippets.set(r.id, r.snippet);
    }
  }

  const someOnly = hits.some((h) => !h.allWords);
  const lines: string[] = [
    `Search for "${q}" (${scope}): ${hits.length} result${hits.length === 1 ? '' : 's'}, best first.${someOnly ? ' Results marked "some words" have only some of the words.' : ''}`,
  ];
  hits.forEach((hit, i) => {
    const snippet = clip(cleanPassage(snippets.get(hit.id) ?? ''), SNIPPET_CHARS);
    const some = hit.allWords ? '' : ' · some words';
    if (hit.kind === 'document') {
      const doc = library.get(hit.id);
      if (!doc) return;
      lines.push(
        '',
        `${i + 1}. "${doc.title}" · id ${doc.id}`,
        `   ${describeWhere(doc, ctx)} · ${formatNumber(doc.wordCount)} words · last changed ${formatWriterShortDate(doc.updatedAt)}${some}`,
        `   ${snippet || '(no matching passage in the text; the title or logline matched)'}`
      );
    } else {
      const capture = captureRows.get(hit.id);
      if (!capture) return;
      const status = capture.status === 'dismissed' ? ', dismissed' : '';
      lines.push(
        '',
        `${i + 1}. Quick capture from ${formatWriterShortDate(capture.created_at)}${capture.project ? ` (project: ${capture.project})` : ''}${status} · id ${hit.id}${some}`,
        `   ${snippet || clip(cleanPassage(capture.content), SNIPPET_CHARS)}`
      );
    }
  });
  return { content: lines.join('\n') };
}

// ─── read_document ───────────────────────────────────────────────────────────

/** Lower is a better match for a title the model gave. */
function candidateTier(doc: DocInfo, ctx: ArchiveToolContext): number {
  const project = doc.projectId === ctx.projectId ? 0 : 10;
  const area = doc.area === 'book' ? 0 : doc.area === 'binder' ? 1 : doc.area === 'other' ? 2 : 5;
  return project + area;
}

type Resolved =
  | { kind: 'document'; doc: DocInfo }
  | { kind: 'capture'; id: string }
  | { kind: 'ambiguous'; candidates: DocInfo[] }
  | { kind: 'missing' };

async function resolveDocument(ctx: ArchiveToolContext, library: Map<string, DocInfo>, ref: string): Promise<Resolved> {
  if (UUID.test(ref)) {
    const doc = library.get(ref.toLowerCase());
    if (doc) return { kind: 'document', doc };
    const capture = await query(`SELECT 1 FROM quick_captures WHERE id = $1 AND user_id = $2`, [ref, ctx.userId]);
    return capture.rows.length > 0 ? { kind: 'capture', id: ref } : { kind: 'missing' };
  }
  const key = normalizeTitle(ref);
  if (!key) return { kind: 'missing' };
  const pick = (list: DocInfo[]): Resolved => {
    if (list.length === 0) return { kind: 'missing' };
    const sorted = [...list].sort((a, b) => candidateTier(a, ctx) - candidateTier(b, ctx) || a.order - b.order);
    const best = sorted[0]!;
    const tied = sorted.filter((d) => candidateTier(d, ctx) === candidateTier(best, ctx));
    return tied.length === 1 ? { kind: 'document', doc: best } : { kind: 'ambiguous', candidates: sorted.slice(0, 8) };
  };
  const exact = [...library.values()].filter((d) => normalizeTitle(d.title) === key);
  if (exact.length > 0) return pick(exact);
  if (key.length < 3) return { kind: 'missing' };
  const partial = [...library.values()].filter((d) => d.area !== 'trash' && normalizeTitle(d.title).includes(key));
  return pick(partial);
}

/** Split text into parts of about PART_CHARS, at paragraph breaks where possible. */
function splitIntoParts(content: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const paragraph of content.split('\n\n')) {
    if (current && current.length + paragraph.length + 2 > PART_CHARS) {
      parts.push(current);
      current = '';
    }
    let rest = paragraph;
    while (rest.length > PART_CHARS) {
      if (current) {
        parts.push(current);
        current = '';
      }
      parts.push(rest.slice(0, PART_CHARS));
      rest = rest.slice(PART_CHARS);
    }
    current = current ? `${current}\n\n${rest}` : rest;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

function renderParts(header: string[], content: string, part: number, note: string | null): ToolOutcome {
  const parts = splitIntoParts(content);
  if (part > parts.length) {
    return { content: `${header[0]} has ${parts.length} part${parts.length === 1 ? '' : 's'}; there's no part ${part}.`, isError: true };
  }
  const lines = [...header];
  if (parts.length > 1) {
    lines.push(
      `Part ${part} of ${parts.length}.${part < parts.length ? ` Read part ${part + 1} for more.` : ' This is the end.'}`
    );
  }
  if (note) lines.push(note);
  lines.push('', '<document>', parts[part - 1]!, '</document>');
  return { content: lines.join('\n') };
}

async function readDocument(
  ctx: ArchiveToolContext,
  input: unknown,
  announce: (label: string) => void
): Promise<ToolOutcome> {
  const ref = text(input, 'document');
  if (!ref) return { content: 'Give read_document an id from search_writing, or a title.', isError: true };
  const part = int(input, 'part', 1, 1000, 1);
  const library = await loadLibrary(ctx.userId);
  const resolved = await resolveDocument(ctx, library, ref);

  if (resolved.kind === 'missing') {
    announce(`Looking for “${clip(ref, 60)}”`);
    return {
      content: `There's no document ${UUID.test(ref) ? `with id ${ref}` : `titled "${ref}"`} in the writer's projects. Use search_writing to find it.`,
      isError: true,
    };
  }
  if (resolved.kind === 'ambiguous') {
    announce(`Looking for “${clip(ref, 60)}”`);
    const lines = [`Several documents match "${ref}". Read one by its id:`];
    for (const d of resolved.candidates) lines.push(`- "${d.title}" · id ${d.id} · ${describeWhere(d, ctx)}`);
    return { content: lines.join('\n') };
  }
  if (resolved.kind === 'capture') {
    const row = (
      await query<{ content: string; status: string; created_at: Date; project: string | null }>(
        `SELECT c.content, c.status, c.created_at, p.name AS project
         FROM quick_captures c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = $1 AND c.user_id = $2`,
        [resolved.id, ctx.userId]
      )
    ).rows[0];
    if (!row) return { content: `There's no capture with id ${resolved.id}.`, isError: true };
    announce('Reading a quick capture');
    const status = row.status === 'dismissed' ? ' (the writer dismissed it)' : '';
    return renderParts(
      [`Quick capture from ${formatWriterShortDate(row.created_at)}${row.project ? `, project: ${row.project}` : ''}${status} · id ${resolved.id}`],
      cleanForReading(row.content),
      part,
      null
    );
  }

  const doc = resolved.doc;
  announce(`Reading “${clip(doc.title, 60)}”`);
  if (ctx.inPrompt.has(doc.id)) {
    return {
      content: `"${doc.title}" is ${describeWhere(doc, ctx)}, so there's no need to read it here.`,
    };
  }
  const row = (await query<{ content: string | null }>(`SELECT content FROM corpus_documents WHERE id = $1`, [doc.id])).rows[0];
  const header = [
    `"${doc.title}" · id ${doc.id}`,
    `Where: ${describeWhere(doc, ctx)} · ${formatNumber(doc.wordCount)} words · last changed ${formatWriterShortDate(doc.updatedAt)}`,
  ];
  const note = doc.area === 'trash' ? 'This is deleted work: it is in Trash, not in the binder.' : null;
  return renderParts(header, cleanForReading(row?.content ?? ''), part, note);
}

// ─── search_conversations ────────────────────────────────────────────────────

const CONVERSATION_HEADLINE =
  'MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … ", StartSel=«, StopSel=»';
const REPLY_CONTEXT_CHARS = 400;
const HITS_PER_SESSION = 2;

async function searchConversations(
  ctx: ArchiveToolContext,
  input: unknown,
  announce: (label: string) => void
): Promise<ToolOutcome> {
  const q = text(input, 'query');
  if (!q) return { content: 'Give search_conversations some words to look for.', isError: true };
  const limit = int(input, 'limit', 1, CONVERSATION_LIMIT_MAX, CONVERSATION_LIMIT_DEFAULT);
  announce(`Looking back through your conversations for “${clip(q, 60)}”`);
  if (!(await hasSearchableWords(q))) {
    return { content: `"${q}" is all common words, which the search skips. Try more distinctive words.` };
  }
  const anyWords = anyWordsQuery(q) || q;

  // Commands the writer typed and the app's fixed replies to them aren't
  // conversation; what's already in this request isn't worth finding again.
  const result = await query<{
    id: string;
    session_id: string;
    role: 'user' | 'assistant';
    created_at: Date;
    started_at: Date;
    project_id: string;
    project_name: string;
    all_words: boolean;
    snippet: string;
  }>(
    `SELECT m.id, m.session_id, m.role, m.created_at, s.started_at, p.id AS project_id,
            p.name AS project_name, (to_tsvector('english', m.content) @@ qa) AS all_words,
            CASE WHEN length(m.content) <= $7 THEN m.content
                 ELSE ts_headline('english', m.content, qo, $6) END AS snippet
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN projects p ON p.id = s.project_id,
          websearch_to_tsquery('english', $2) qa,
          websearch_to_tsquery('english', $3) qo
     WHERE p.user_id = $1
       AND m.role IN ('user', 'assistant')
       AND NOT (m.role = 'user' AND left(btrim(m.content), 1) = '/')
       AND m.model_reason IS DISTINCT FROM 'Workflow command'
       AND NOT (m.session_id = $4 AND m.created_at >= $5)
       AND to_tsvector('english', m.content) @@ qo
     ORDER BY all_words DESC, ts_rank_cd(to_tsvector('english', m.content), qo, 1 | 32) DESC, m.created_at DESC
     LIMIT 40`,
    [ctx.userId, q, anyWords, ctx.sessionId, ctx.visibleSince, CONVERSATION_HEADLINE, SNIPPET_CHARS]
  );
  if (result.rows.length === 0) {
    return { content: `No past conversations mention "${q}". Try other words, or ask the writer.` };
  }

  // Up to `limit` sessions, a couple of hits from each.
  const sessions = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const list = sessions.get(row.session_id);
    if (list) {
      if (list.length < HITS_PER_SESSION) list.push(row);
    } else if (sessions.size < limit) {
      sessions.set(row.session_id, [row]);
    }
  }

  const someOnly = [...sessions.values()].flat().some((r) => !r.all_words);
  const lines: string[] = [
    `Conversations mentioning "${q}": ${sessions.size} session${sessions.size === 1 ? '' : 's'}, most relevant first.${someOnly ? ' Lines marked "some words" have only some of the words.' : ''}`,
  ];
  let n = 0;
  for (const [sessionId, rows] of sessions) {
    const first = rows[0]!;
    const when =
      sessionId === ctx.sessionId
        ? 'Earlier in this session'
        : `Session of ${formatWriterShortDate(first.started_at)}`;
    const project = first.project_id !== ctx.projectId ? ` (project: ${first.project_name})` : '';
    lines.push('', `${++n}. ${when}${project}`);
    // Messages already shown, so one exchange isn't listed from both sides.
    const shown = new Set<string>();
    for (const row of rows) {
      if (shown.has(row.id)) continue;
      shown.add(row.id);
      // The other side of the exchange: what the writer asked, or how Quinn answered.
      const neighbor = (
        await query<{ id: string; content: string }>(
          row.role === 'assistant'
            ? `SELECT id, content FROM messages WHERE session_id = $1 AND role = 'user' AND created_at < $2
               ORDER BY created_at DESC LIMIT 1`
            : `SELECT id, content FROM messages WHERE session_id = $1 AND role = 'assistant' AND created_at > $2
               ORDER BY created_at ASC LIMIT 1`,
          [row.session_id, row.created_at]
        )
      ).rows[0];
      const speaker = row.role === 'user' ? 'The writer' : 'You';
      const some = row.all_words ? '' : ' (some words)';
      const said = `   ${speaker}${some}: ${clip(cleanPassage(row.snippet), SNIPPET_CHARS)}`;
      if (neighbor && !shown.has(neighbor.id)) {
        shown.add(neighbor.id);
        const other = clip(cleanPassage(neighbor.content), REPLY_CONTEXT_CHARS);
        // In the order they were said.
        if (row.role === 'user') lines.push(said, `   You replied: "${other}"`);
        else lines.push(`   The writer had said: "${other}"`, said);
      } else {
        lines.push(said);
      }
    }
  }
  return { content: lines.join('\n') };
}

// ─── piece_history ───────────────────────────────────────────────────────────

async function pieceHistory(
  ctx: ArchiveToolContext,
  input: unknown,
  announce: (label: string) => void
): Promise<ToolOutcome> {
  const piece = text(input, 'piece');
  if (!piece) return { content: 'Give piece_history the title of a piece.', isError: true };
  announce(`Looking at earlier versions of “${clip(piece, 60)}”`);
  return {
    content: await buildRevisionHistoryContext(ctx.projectId, piece, {
      includeEarliest: flag(input, 'include_earliest_text'),
    }),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Run one tool call. `announce` tells the writer what Quinn is looking up.
 * Bad input comes back as an error result the model can correct; failures
 * (e.g. the database) throw, and the caller reports them to the model.
 */
export async function runArchiveTool(
  ctx: ArchiveToolContext,
  call: ToolCall,
  announce: (label: string) => void
): Promise<ToolOutcome> {
  const started = Date.now();
  let outcome: ToolOutcome;
  switch (call.name) {
    case 'search_writing':
      outcome = await searchWriting(ctx, call.input, announce);
      break;
    case 'read_document':
      outcome = await readDocument(ctx, call.input, announce);
      break;
    case 'search_conversations':
      outcome = await searchConversations(ctx, call.input, announce);
      break;
    case 'piece_history':
      outcome = await pieceHistory(ctx, call.input, announce);
      break;
    default:
      outcome = { content: `There's no tool called ${call.name}.`, isError: true };
  }
  console.log(
    `[Tools] ${call.name} ${clip(JSON.stringify(call.input ?? {}), 160)} → ${formatNumber(outcome.content.length)} chars${outcome.isError ? ' (error)' : ''} in ${Date.now() - started} ms`
  );
  return outcome;
}
