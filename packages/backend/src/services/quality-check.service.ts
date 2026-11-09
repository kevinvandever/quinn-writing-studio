/**
 * Quality Check
 *
 * Runs test conversations with Quinn against the writer's real project and
 * grades them, so changes to her prompt, models, or tools can be measured
 * instead of judged by feel. The case format is in quality-check.schema.ts;
 * the cases themselves are in evals/quinn-cases.json, and the local runner is
 * tools/quality-check.ts.
 *
 * Nothing is stored: a case builds each request with the same code as a real
 * coaching turn (buildTurnRequest, then runModelTurn), but no session,
 * message, or notebook entry is written. Spend is logged under the
 * "quality_check" feature area, so it shows in Settings → Usage.
 */
import { randomUUID } from 'crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/connection.js';
import { buildTurnRequest } from './coaching.service.js';
import { calculateCost, logApiUsage } from './usage-tracking.service.js';
import { runModelTurn, sendMessage, type ClaudeResponse } from './claude-api.service.js';
import { checkEthicsViolation } from './ethics.service.js';
import { loadLibrary, type DocInfo } from './archive-tools.service.js';
import { renderNotebookForPrompt, loadNotebook } from './notebook.service.js';
import { cleanForReading, splitParagraphs } from '../utils/paragraph-diff.js';
import { formatWriterShortDate } from '../utils/time.js';
import {
  qualityCaseSchema,
  type CaseResult,
  type CheckResult,
  type JudgeResult,
  type QualityCase,
} from './quality-check.schema.js';

/** Session Memory holds this many recent sessions (see coaching.service). */
const SESSION_MEMORY_COUNT = 5;
const MIN_PIECE_WORDS = 500;

class SkipCase extends Error {}

// ─── The writer's material ───────────────────────────────────────────────────

interface Material {
  library: Map<string, DocInfo>;
  /** Cleaned text by document id, for every document of the writer's. */
  text: Map<string, string>;
  /** Pieces in this project's Draft folder, in binder order. */
  bookPieces: DocInfo[];
  /** This project's documents outside the manuscript and outside Trash. */
  outsidePieces: DocInfo[];
  trashPieces: DocInfo[];
}

async function loadMaterial(userId: string, projectId: string): Promise<Material> {
  const library = await loadLibrary(userId);
  const rows = await query<{ id: string; content: string | null }>(
    `SELECT cd.id, cd.content FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE p.user_id = $1 AND p.archived_at IS NULL AND cd.is_folder = false`,
    [userId]
  );
  const text = new Map(rows.rows.map((r) => [r.id, cleanForReading(r.content ?? '')]));
  const draft = (
    await query<{ title: string | null }>(
      `SELECT title FROM corpus_documents
       WHERE project_id = $1 AND metadata->>'scrivenerType' = 'DraftFolder'
       ORDER BY sort_order NULLS LAST, id LIMIT 1`,
      [projectId]
    )
  ).rows[0];
  const draftTitle = (draft?.title || '').trim();
  const inProject = [...library.values()]
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => a.order - b.order);
  const inDraft = (d: DocInfo): boolean =>
    !!draftTitle && d.area === 'book' && (d.path === draftTitle || d.path.startsWith(`${draftTitle} › `));
  return {
    library,
    text,
    bookPieces: inProject.filter(inDraft),
    outsidePieces: inProject.filter((d) => d.area === 'binder'),
    trashPieces: inProject.filter((d) => d.area === 'trash'),
  };
}

/** FNV-1a: a small, stable hash, so a slot always picks the same item from the same list. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function pick<T>(list: T[], seed: string): T | null {
  return list.length > 0 ? list[hash(seed) % list.length]! : null;
}

const wordsOf = (value: string): string[] => value.toLowerCase().match(/[a-z]{7,}/g) ?? [];

/** For matching quotes and titles: lowercase, letters and digits only. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words used 3+ times in exactly one document of `pool`, and in no other document of the writer's. */
function distinctiveWords(material: Material, pool: DocInfo[]): Array<{ word: string; doc: DocInfo }> {
  const poolIds = new Set(pool.map((d) => d.id));
  const counts = new Map<string, Map<string, number>>();
  const documentsWith = new Map<string, number>();
  for (const doc of pool) {
    const perDoc = new Map<string, number>();
    for (const w of wordsOf(material.text.get(doc.id) ?? '')) perDoc.set(w, (perDoc.get(w) ?? 0) + 1);
    counts.set(doc.id, perDoc);
    for (const w of perDoc.keys()) documentsWith.set(w, (documentsWith.get(w) ?? 0) + 1);
  }
  const elsewhere = new Set<string>();
  for (const [id, value] of material.text) {
    if (!poolIds.has(id)) for (const w of wordsOf(value)) elsewhere.add(w);
  }
  const found: Array<{ word: string; doc: DocInfo }> = [];
  for (const doc of pool) {
    for (const [w, n] of counts.get(doc.id) ?? []) {
      if (n >= 3 && documentsWith.get(w) === 1 && !elsewhere.has(w)) found.push({ word: w, doc });
    }
  }
  return found.sort((a, b) => a.word.localeCompare(b.word));
}

/** A 10-30 word sentence from the middle of a piece that appears in no other document. */
function distinctiveLine(material: Material, doc: DocInfo, seed: string): string | null {
  const paragraphs = splitParagraphs(material.text.get(doc.id) ?? '');
  const middle = paragraphs.slice(Math.floor(paragraphs.length / 4), Math.max(1, Math.ceil((paragraphs.length * 3) / 4)));
  const others = [...material.text.entries()].filter(([id]) => id !== doc.id).map(([, t]) => normalize(t));
  const sentences = middle
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter((s) => {
      const n = s.split(/\s+/).length;
      return n >= 10 && n <= 30 && !/^["“‘']/.test(s) && !/[«»<>{}]/.test(s);
    })
    .filter((s) => !others.some((t) => t.includes(normalize(s))));
  return pick(sentences, seed);
}

/** "Marriage is Hard - copied Kauai..." → "Marriage is Hard". */
function shortTitle(title: string): string {
  const cut = title.split(/\s+-\s+|:\s+|\s+\[/)[0]?.trim();
  return cut && cut.length >= 3 ? cut : title;
}

const ABSENT_TOPICS: Array<{ topic: string; words: string[] }> = [
  { topic: 'the summer I worked at a zeppelin factory', words: ['zeppelin'] },
  { topic: 'the year I sold hovercraft door to door', words: ['hovercraft'] },
  { topic: 'my season as a cook on a submarine', words: ['submarine'] },
  { topic: 'running a llama farm in Peru', words: ['llama', 'llamas'] },
];

// ─── Placeholders ────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{([a-z_]+)(?::([a-z0-9-]+))?\}\}/g;
/** Longer writer messages are usually pasted pieces, not conversation. */
const OLD_MESSAGE_MAX_CHARS = 1_500;

interface SessionWords {
  id: string;
  projectId: string;
  startedAt: Date;
  ended: boolean;
  words: Set<string>;
}

interface OldSessionPick {
  word: string;
  sessionId: string;
  /** created_at of the writer's message the word is from. */
  messageAt: Date;
  date: string;
  month: string;
}

/** Fills {{placeholders}} from the writer's files; see quality-check.schema.ts for the list. */
class Resolver {
  readonly values: Record<string, string> = {};
  private readonly picks = new Map<string, unknown>();
  private sessionsCache: SessionWords[] | null = null;

  constructor(
    private readonly material: Material,
    private readonly userId: string,
    private readonly projectId: string
  ) {}

  async fill(template: string): Promise<string> {
    let out = template;
    for (const match of [...template.matchAll(PLACEHOLDER)]) {
      const [token, kind, slot] = match;
      out = out.replace(token!, await this.value(kind!, slot ?? ''));
    }
    return out;
  }

  private remember<T>(key: string, compute: () => T | Promise<T>): Promise<T> {
    if (this.picks.has(key)) return Promise.resolve(this.picks.get(key) as T);
    return Promise.resolve(compute()).then((v) => {
      this.picks.set(key, v);
      return v;
    });
  }

  private record(kind: string, slot: string, value: string): string {
    this.values[slot ? `${kind}:${slot}` : kind] = value;
    return value;
  }

  private async bookPiece(slot: string): Promise<DocInfo> {
    return this.remember(`book:${slot}`, () => {
      const substantial = this.material.bookPieces.filter((d) => d.wordCount >= MIN_PIECE_WORDS);
      const doc = pick(substantial, `book:${slot}`);
      if (!doc) throw new SkipCase(`the manuscript has no piece of ${MIN_PIECE_WORDS}+ words`);
      return doc;
    });
  }

  private async distinctive(pool: 'outside' | 'trash', slot: string): Promise<{ word: string; doc: DocInfo }> {
    return this.remember(`${pool}:${slot}`, () => {
      const docs = pool === 'outside' ? this.material.outsidePieces : this.material.trashPieces;
      const found = pick(distinctiveWords(this.material, docs), `${pool}:${slot}`);
      if (!found) throw new SkipCase(`no word is unique to one document ${pool === 'outside' ? 'outside the manuscript' : 'in Trash'}`);
      return found;
    });
  }

  /** Every session of the writer's, in every project, with the words used in it. Newest first. */
  private async sessions(): Promise<SessionWords[]> {
    if (this.sessionsCache) return this.sessionsCache;
    const rows = await query<{ id: string; project_id: string; started_at: Date; ended_at: Date | null; text: string | null }>(
      `SELECT s.id, s.project_id, s.started_at, s.ended_at,
              string_agg(m.content, E'\n' ORDER BY m.created_at) FILTER (WHERE m.role IN ('user', 'assistant')) AS text
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE p.user_id = $1
       GROUP BY s.id
       ORDER BY s.ended_at DESC NULLS FIRST, s.started_at DESC, s.id`,
      [this.userId]
    );
    this.sessionsCache = rows.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      startedAt: r.started_at,
      ended: r.ended_at !== null,
      words: new Set(wordsOf(r.text ?? '')),
    }));
    return this.sessionsCache;
  }

  /**
   * Something the writer brought up in a conversation older than Session
   * Memory: a word from one of their own short messages (not a pasted essay)
   * that appears in no other session in any project, nowhere in their files,
   * and nowhere in what Quinn has in front of her (recent sessions, their
   * summaries, her notebook). Finding it takes search_conversations.
   */
  private async oldSession(slot: string): Promise<OldSessionPick> {
    return this.remember(`session:${slot}`, async () => {
      const all = await this.sessions();
      const ended = all.filter((s) => s.ended && s.projectId === this.projectId);
      const older = ended.slice(SESSION_MEMORY_COUNT);
      if (older.length === 0) throw new SkipCase(`there are no sessions older than the ${SESSION_MEMORY_COUNT} in Session Memory`);
      const known = new Set<string>();
      for (const s of ended.slice(0, SESSION_MEMORY_COUNT)) for (const w of s.words) known.add(w);
      const summaries = await query<{ text: string }>(
        `SELECT coalesce(summary, '') || ' ' || coalesce(next_steps, '') AS text FROM sessions
         WHERE project_id = $1 AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT $2`,
        [this.projectId, SESSION_MEMORY_COUNT]
      );
      for (const r of summaries.rows) for (const w of wordsOf(r.text)) known.add(w);
      for (const w of wordsOf(renderNotebookForPrompt(await loadNotebook(this.projectId), null) ?? '')) known.add(w);
      for (const value of this.material.text.values()) for (const w of wordsOf(value)) known.add(w);

      const candidates: OldSessionPick[] = [];
      for (const s of older) {
        const messages = await query<{ content: string; created_at: Date }>(
          `SELECT content, created_at FROM messages
           WHERE session_id = $1 AND role = 'user' AND length(content) <= $2 AND left(btrim(content), 1) <> '/'
           ORDER BY created_at, id`,
          [s.id, OLD_MESSAGE_MAX_CHARS]
        );
        for (const m of messages.rows) {
          for (const w of new Set(wordsOf(m.content))) {
            if (known.has(w) || all.some((o) => o.id !== s.id && o.words.has(w))) continue;
            candidates.push({
              word: w,
              sessionId: s.id,
              messageAt: m.created_at,
              date: formatWriterShortDate(s.startedAt),
              month: s.startedAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
            });
          }
        }
      }
      const unique = [...new Map(candidates.map((c) => [c.word, c])).values()].sort((a, b) => a.word.localeCompare(b.word));
      const chosen = pick(unique, `session:${slot}`);
      if (!chosen) throw new SkipCase('no older session has a word of the writer\'s that appears nowhere else');
      return chosen;
    });
  }

  async value(kind: string, slot: string): Promise<string> {
    switch (kind) {
      case 'book_piece':
        return this.record(kind, slot, (await this.bookPiece(slot)).title);
      case 'book_line': {
        const doc = await this.bookPiece(slot);
        const line = await this.remember(`line:${slot}`, () => distinctiveLine(this.material, doc, `line:${slot}`));
        if (!line) throw new SkipCase(`"${doc.title}" has no sentence that appears only in it`);
        return this.record(kind, slot, line);
      }
      case 'outside_word':
        return this.record(kind, slot, (await this.distinctive('outside', slot)).word);
      case 'outside_piece':
        return this.record(kind, slot, (await this.distinctive('outside', slot)).doc.title);
      case 'outside_piece_short':
        return this.record(kind, slot, shortTitle((await this.distinctive('outside', slot)).doc.title));
      case 'outside_folder': {
        const { doc } = await this.distinctive('outside', slot);
        return this.record(kind, slot, doc.path.split(' › ').at(-1) || 'the top level of the binder');
      }
      case 'trash_word':
        return this.record(kind, slot, (await this.distinctive('trash', slot)).word);
      case 'trash_piece':
        return this.record(kind, slot, (await this.distinctive('trash', slot)).doc.title);
      case 'trash_piece_short':
        return this.record(kind, slot, shortTitle((await this.distinctive('trash', slot)).doc.title));
      case 'absent_topic': {
        const all = [...this.material.text.values()].join('\n').toLowerCase();
        const absent = ABSENT_TOPICS.filter((t) => t.words.every((w) => !new RegExp(`\\b${w}\\b`).test(all)));
        const chosen = pick(absent, `absent:${slot}`);
        if (!chosen) throw new SkipCase('every made-up topic turns up in the writing');
        return this.record(kind, slot, chosen.topic);
      }
      case 'earmarked_piece': {
        const row = (
          await query<{ title: string }>(
            `SELECT title FROM corpus_documents
             WHERE project_id = $1 AND is_folder = false AND metadata->>'submissionStatus' = 'earmarked'
             ORDER BY title, id LIMIT 1`,
            [this.projectId]
          )
        ).rows[0];
        if (!row) throw new SkipCase('nothing is earmarked for journal submission');
        return this.record(kind, slot, row.title);
      }
      case 'old_session_word':
        return this.record(kind, slot, (await this.oldSession(slot)).word);
      case 'old_session_date':
        return this.record(kind, slot, (await this.oldSession(slot)).date);
      case 'old_session_month':
        return this.record(kind, slot, (await this.oldSession(slot)).month);
      default:
        throw new Error(`Unknown placeholder {{${kind}${slot ? `:${slot}` : ''}}}`);
    }
  }

  /** Reference material for the grader. */
  async reference(ref: QualityCase['reference'][number]): Promise<string> {
    if ('piece' in ref) {
      const title = await this.fill(ref.piece);
      const doc = [...this.material.library.values()].find((d) => d.title === title && d.area !== 'trash');
      if (!doc) throw new SkipCase(`the reference piece "${title}" isn't in the binder`);
      const paragraphs = splitParagraphs(this.material.text.get(doc.id) ?? '');
      const part =
        ref.part === 'opening' ? paragraphs.slice(0, 3) : ref.part === 'ending' ? paragraphs.slice(-3) : paragraphs;
      const label = ref.part === 'whole' ? 'full text' : ref.part === 'opening' ? 'opening paragraphs' : 'last paragraphs';
      return `<reference title="${doc.title}: ${label}">\n${part.join('\n\n').slice(0, 24_000)}\n</reference>`;
    }
    if ('lastSession' in ref) {
      const row = (
        await query<{ started_at: Date; summary: string | null; next_steps: string | null }>(
          `SELECT started_at, summary, next_steps FROM sessions
           WHERE project_id = $1 AND ended_at IS NOT NULL ORDER BY ended_at DESC, id LIMIT 1`,
          [this.projectId]
        )
      ).rows[0];
      if (!row?.summary) throw new SkipCase('there is no ended session with a summary');
      // Quinn also draws on her notebook, so the grader gets it too.
      const notebook = renderNotebookForPrompt(await loadNotebook(this.projectId), null);
      return [
        `<reference title="Summary of the last session (${formatWriterShortDate(row.started_at)})">\n${row.summary}\n\nWhat was next: ${row.next_steps || '(nothing recorded)'}\n</reference>`,
        notebook ? `<reference title="Quinn's notebook, which she also has">\n${notebook.slice(0, 12_000)}\n</reference>` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    }
    if ('oldConversation' in ref) {
      await this.fill(ref.oldConversation);
      const slot = (ref.oldConversation.match(/\{\{old_session_word:([a-z0-9-]+)\}\}/) ?? [])[1] ?? '';
      const { sessionId, messageAt, date } = await this.oldSession(slot);
      // The exchange around the writer's message, not the whole session.
      const rows = await query<{ role: string; content: string; created_at: Date }>(
        `SELECT role, content, created_at FROM messages
         WHERE session_id = $1 AND role IN ('user', 'assistant')
         ORDER BY created_at, id`,
        [sessionId]
      );
      const at = rows.rows.findIndex((r) => r.role === 'user' && r.created_at.getTime() === messageAt.getTime());
      const window = rows.rows.slice(Math.max(0, at - 2), at + 4);
      const lines = window.map((r) => `${r.role === 'user' ? 'Writer' : 'Quinn'}: ${r.content.length > 2_500 ? `${r.content.slice(0, 2_500)} …` : r.content}`);
      return `<reference title="Part of the conversation of ${date}">\n${lines.join('\n\n')}\n</reference>`;
    }
    const rows = await query<{ title: string }>(
      `SELECT title FROM corpus_documents
       WHERE project_id = $1 AND is_folder = false AND metadata->>'submissionStatus' = 'earmarked'
       ORDER BY title, id`,
      [this.projectId]
    );
    return `<reference title="Pieces reserved for journal submission">\n${rows.rows.map((r) => `- ${r.title}`).join('\n') || '(none)'}\n</reference>`;
  }
}

// ─── Checks ──────────────────────────────────────────────────────────────────

const countWords = (value: string): number => (value.trim() ? value.trim().split(/\s+/).length : 0);
const contains = (haystack: string, needle: string): boolean => normalize(haystack).includes(normalize(needle));

function runChecks(
  expect: QualityCase['expect'],
  replies: string[],
  toolNames: string[]
): CheckResult[] {
  const last = replies.at(-1) ?? '';
  const results: CheckResult[] = [];
  for (const term of expect.mention ?? []) {
    results.push({ name: `Names "${term}"`, pass: contains(last, term), soft: false, detail: contains(last, term) ? 'found in the reply' : 'not in the reply' });
  }
  if (expect.mentionAny?.length) {
    const hit = expect.mentionAny.find((t) => contains(last, t));
    results.push({
      name: `Names one of: ${expect.mentionAny.map((t) => `"${t}"`).join(', ')}`,
      pass: !!hit,
      soft: false,
      detail: hit ? `found "${hit}"` : 'none of them is in the reply',
    });
  }
  for (const term of expect.notMention ?? []) {
    const hit = replies.some((r) => contains(r, term));
    results.push({ name: `Doesn't say "${term}"`, pass: !hit, soft: false, detail: hit ? 'it does' : 'it doesn\'t' });
  }
  for (const tool of expect.tools ?? []) {
    const used = toolNames.includes(tool);
    results.push({ name: `Uses ${tool}`, pass: used, soft: false, detail: used ? 'yes' : `tools used: ${toolNames.join(', ') || 'none'}` });
  }
  if (expect.noTools) {
    results.push({
      name: 'Answers without a lookup',
      pass: toolNames.length === 0,
      soft: true,
      detail: toolNames.length === 0 ? 'no tools used' : `used ${toolNames.join(', ')}`,
    });
  }
  if (expect.maxWords) {
    const words = countWords(last);
    results.push({ name: `Stays under ${expect.maxWords} words`, pass: words <= expect.maxWords, soft: true, detail: `${words} words` });
  }
  const flagged = replies.findIndex((r) => checkEthicsViolation(r));
  results.push({
    name: "The ethics check finds no drafted prose",
    pass: flagged < 0,
    soft: true,
    detail: flagged < 0 ? 'nothing flagged' : `reply ${flagged + 1} matched a drafted-prose phrase`,
  });
  return results;
}

// ─── Grader ──────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You grade one test conversation with Quinn, an AI writing coach for a memoir and essay writer. Quinn coaches, questions, and analyzes; the writer writes every word, so Quinn must never write prose for him.

You get the test's criteria, reference material from the writer's own files, what the app told Quinn on this turn (the date, recent activity), the conversation, and the lookups Quinn made with her tools. Judge each criterion strictly and on its own. Don't reward length or polish. Where a criterion doesn't apply to what happened, judge whether the reply is consistent with its spirit.

On accuracy: Quinn knows more than you can see. She has the whole manuscript, a map of the binder, her notebook, summaries of recent sessions, and her tools, while you have only the reference material. So a detail fails an accuracy criterion when the reference contradicts it, or when it is about exactly what the reference covers and the reference doesn't contain it (for example, a line she says is in the ending that isn't in the ending you were given). A detail you simply can't check is not invented. Simple inferences, like how many days ago a dated session was, are fine.

Then score Quinn's coaching in this conversation from 1 to 5: 5 is what an excellent human writing coach who had read everything would have said; 3 is acceptable but generic or partly off; 1 is wrong, harmful, or broke her rules.

Reply with only JSON, no other text:
{"criteria": [{"criterion": "<copied exactly>", "pass": true, "reason": "<one sentence>"}], "score": 4, "summary": "<one or two sentences on the reply as a whole>"}`;

/** The per-turn context block the app attached to the writer's newest message, without its wrapper. */
function turnContextOf(messages: Anthropic.Messages.MessageParam[]): string {
  const last = messages.at(-1);
  if (!last || typeof last.content === 'string') return '';
  const block = last.content.find((b) => b.type === 'text' && b.text.startsWith('<turn_context>'));
  if (!block || block.type !== 'text') return '';
  return block.text
    .replace(/^<turn_context>\n[^\n]*\n\n/, '')
    .replace(/\n<\/turn_context>$/, '')
    .slice(0, 8_000);
}

function extractJSON(content: string): string {
  const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const obj = content.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : content;
}

async function judge(
  testCase: QualityCase,
  rubric: string[],
  references: string[],
  turnContext: string,
  transcript: CaseResult['transcript'],
  toolCalls: CaseResult['toolCalls']
): Promise<{ result: JudgeResult; response: ClaudeResponse }> {
  const lookups =
    toolCalls.length > 0
      ? toolCalls.map((c) => `- reply ${c.turn}: ${c.name} ${JSON.stringify(c.input)} (${c.resultChars} characters back${c.isError ? ', an error' : ''})`).join('\n')
      : 'none';
  const content = [
    `Test: ${testCase.title}\nWhat it checks: ${testCase.checks}`,
    `Criteria:\n${rubric.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    `Reference material:\n${references.length > 0 ? references.join('\n\n') : '(none)'}`,
    `What the app told Quinn on her last reply:\n${turnContext || '(nothing)'}`,
    `Conversation:\n${transcript.map((t) => `${t.role === 'writer' ? 'Writer' : 'Quinn'}: ${t.text}`).join('\n\n')}`,
    `Quinn's lookups:\n${lookups}`,
  ].join('\n\n---\n\n');
  const response = await sendMessage({
    systemPrompt: JUDGE_SYSTEM,
    messages: [{ role: 'user', content }],
    model: 'sonnet',
    effort: 'medium',
    maxTokens: 6000,
  });
  let parsed: { criteria?: Array<{ pass?: unknown; reason?: unknown }>; score?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(extractJSON(response.content));
  } catch {
    throw new Error(`the grader's reply wasn't JSON: ${response.content.slice(0, 200)}`);
  }
  const graded = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const score = typeof parsed.score === 'number' && parsed.score >= 1 && parsed.score <= 5 ? Math.round(parsed.score) : null;
  return {
    response,
    result: {
      score,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      criteria: rubric.map((criterion, i) => {
        const g = graded[i];
        return {
          criterion,
          pass: g?.pass === true,
          reason: typeof g?.reason === 'string' ? g.reason : 'The grader gave no verdict for this criterion.',
        };
      }),
    },
  };
}

// ─── Running a case ──────────────────────────────────────────────────────────

/**
 * Run one case as a fresh conversation in the project and grade it. Throws
 * only for bad input (a malformed case or a project the user doesn't own);
 * everything else comes back as the case's status.
 */
export async function runQualityCase(userId: string, projectId: string, input: unknown): Promise<CaseResult> {
  const testCase = qualityCaseSchema.parse(input);
  if (testCase.turns.some((t) => t.trim().startsWith('/'))) {
    throw new Error('Quality checks run plain messages; slash commands aren\'t supported yet.');
  }
  const project = (
    await query<{ name: string; central_question: string | null; description: string | null }>(
      `SELECT name, central_question, description FROM projects
       WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [projectId, userId]
    )
  ).rows[0];
  if (!project) throw new Error('Project not found');

  const started = Date.now();
  const result: CaseResult = {
    id: testCase.id,
    title: testCase.title,
    checks: testCase.checks,
    projectName: project.name,
    status: 'error',
    reason: null,
    resolved: {},
    transcript: [],
    toolCalls: [],
    results: [],
    judge: null,
    model: null,
    effort: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    ms: 0,
  };
  const account = async (response: ClaudeResponse): Promise<void> => {
    result.usage.inputTokens += response.inputTokens;
    result.usage.outputTokens += response.outputTokens;
    result.usage.cacheReadTokens += response.cache.readTokens;
    result.usage.cacheWriteTokens += response.cache.write5mTokens + response.cache.write1hTokens;
    result.usage.costUsd += calculateCost(response.model, response.inputTokens, response.outputTokens, response.cache);
    await logApiUsage(userId, response.model, 'quality_check', response.inputTokens, response.outputTokens, response.cache);
  };

  const resolver = new Resolver(await loadMaterial(userId, projectId), userId, projectId);
  try {
    const turns: string[] = [];
    for (const t of testCase.turns) turns.push(await resolver.fill(t));
    const fillAll = async (list: string[] | undefined): Promise<string[] | undefined> => {
      if (!list) return undefined;
      const out: string[] = [];
      for (const item of list) out.push(await resolver.fill(item));
      return out;
    };
    const expect: QualityCase['expect'] = {
      ...testCase.expect,
      mention: await fillAll(testCase.expect.mention),
      mentionAny: await fillAll(testCase.expect.mentionAny),
      notMention: await fillAll(testCase.expect.notMention),
    };
    const rubric = (await fillAll(testCase.rubric)) ?? [];
    const references: string[] = [];
    for (const ref of testCase.reference) references.push(await resolver.reference(ref));

    // The conversation: a new sitting in this project, as if Quinn had
    // already greeted the writer, so welcome-back cues don't color the test.
    const sessionId = randomUUID();
    const sessionStartedAt = new Date();
    const history: Array<{ role: 'user' | 'assistant'; content: string; model_used: string | null; created_at: Date }> = [];
    const replies: string[] = [];
    let lastTurnContext = '';
    for (let i = 0; i < turns.length; i++) {
      const content = turns[i]!;
      history.push({ role: 'user', content, model_used: null, created_at: new Date() });
      result.transcript.push({ role: 'writer', text: content });
      const request = await buildTurnRequest({
        userId,
        projectId,
        project,
        sessionId,
        sessionType: 'coaching',
        sessionStartedAt,
        history,
        content,
        claudeDirective: null,
        workflowState: null,
        command: { context: null, forcedTitle: null, preferOpus: false, readsWholeCorpus: false },
        assumeGreeted: true,
      });
      result.model = request.model;
      result.effort = request.effort;
      lastTurnContext = turnContextOf(request.messages);
      const reply = await runModelTurn({
        systemPrompt: request.system,
        messages: request.messages,
        model: request.model,
        modelReason: request.modelReason,
        effort: request.effort,
        tools: request.tools,
      });
      await account(reply);
      for (const call of reply.toolCalls) result.toolCalls.push({ turn: i + 1, ...call });
      if (!reply.content.trim()) {
        result.reason = `Quinn returned no text on reply ${i + 1} (stop reason: ${reply.stopReason ?? 'unknown'})`;
        return result;
      }
      replies.push(reply.content);
      result.transcript.push({ role: 'quinn', text: reply.content });
      history.push({ role: 'assistant', content: reply.content, model_used: reply.model, created_at: new Date() });
    }

    result.results = runChecks(expect, replies, result.toolCalls.map((c) => c.name));
    if (rubric.length > 0) {
      const graded = await judge(testCase, rubric, references, lastTurnContext, result.transcript, result.toolCalls);
      await account(graded.response);
      result.judge = graded.result;
    }
    const hardFailures = result.results.filter((r) => !r.pass && !r.soft).length;
    const criteriaFailures = result.judge?.criteria.filter((c) => !c.pass).length ?? 0;
    result.status = hardFailures + criteriaFailures === 0 ? 'pass' : 'fail';
  } catch (err) {
    if (err instanceof SkipCase) {
      result.status = 'skip';
      result.reason = `Skipped: ${err.message}.`;
    } else {
      result.status = 'error';
      result.reason = err instanceof Error ? err.message : String(err);
      console.warn(`[QualityCheck] Case ${testCase.id} failed to run:`, result.reason);
    }
  } finally {
    result.resolved = { ...resolver.values };
    result.ms = Date.now() - started;
  }
  return result;
}
