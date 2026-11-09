/**
 * Quality check cases: the format of evals/quinn-cases.json, and of what a
 * case run returns. No database or config imports, so the local runner
 * (tools/quality-check.ts) can use it with only the watcher's .env.
 *
 * Strings in a case may hold placeholders, filled in from the writer's own
 * files when the case runs (see quality-check.service.ts), so the case file
 * itself contains none of their writing:
 *
 *   {{book_piece:a}}           a piece in the manuscript (Draft folder), picked by the slot name "a"
 *   {{book_line:a}}            a sentence from the middle of that piece
 *   {{outside_word:e}}         a word used in exactly one document outside the manuscript, and nowhere else
 *   {{outside_piece:e}}        that document's title ({{outside_piece_short:e}}: the part before " - " or ":")
 *   {{outside_folder:e}}       the folder it's in
 *   {{trash_word:t}}           the same, for a document in Trash ({{trash_piece:t}}, {{trash_piece_short:t}})
 *   {{absent_topic:x}}         a topic that appears nowhere in the writer's files
 *   {{earmarked_piece}}        a piece reserved for journal submission
 *   {{old_session_word:s}}     a word the writer used in one older session (beyond Session Memory)
 *   {{old_session_date:s}}     that session's date
 *
 * The same slot name always picks the same thing from the same binder. A case
 * whose placeholders can't be filled (nothing earmarked, say) is skipped.
 */
import { z } from 'zod';

const placeholderText = (max: number) => z.string().min(1).max(max);

export const referenceSchema = z.union([
  z.object({
    piece: placeholderText(500),
    part: z.enum(['whole', 'opening', 'ending']).default('whole'),
  }),
  z.object({ lastSession: z.literal(true) }),
  z.object({ oldConversation: placeholderText(200) }),
  z.object({ earmarks: z.literal(true) }),
]);

export const qualityCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/, 'ids are lowercase letters, digits, and dashes'),
  title: z.string().min(1).max(120),
  /** What the case checks, in a sentence, for the report. */
  checks: z.string().min(1).max(500),
  /** The writer's messages, in order. */
  turns: z.array(placeholderText(4000)).min(1).max(4),
  expect: z
    .object({
      /** Every one of these must appear in Quinn's last reply (case, quotes, and punctuation ignored). */
      mention: z.array(placeholderText(500)).max(6).optional(),
      /** At least one of these must appear in Quinn's last reply. */
      mentionAny: z.array(placeholderText(500)).max(6).optional(),
      /** None of these may appear in any of Quinn's replies. */
      notMention: z.array(placeholderText(500)).max(6).optional(),
      /** Each of these tools must be used at least once. */
      tools: z.array(z.string().min(1).max(60)).max(4).optional(),
      /** Quinn shouldn't need a tool (a warning, not a failure). */
      noTools: z.boolean().optional(),
      /** Quinn's last reply should stay under this many words (a warning, not a failure). */
      maxWords: z.number().int().min(20).max(5000).optional(),
    })
    .default({}),
  /** Criteria for the grader: each is a statement a good reply makes true. */
  rubric: z.array(placeholderText(400)).max(8).default([]),
  /** Material from the writer's files the grader gets, to check Quinn's facts. */
  reference: z.array(referenceSchema).max(4).default([]),
});

export type QualityCase = z.infer<typeof qualityCaseSchema>;
export type QualityCaseInput = z.input<typeof qualityCaseSchema>;

export const qualityCaseFileSchema = z.object({
  cases: z
    .array(qualityCaseSchema)
    .min(1)
    .max(40)
    .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, 'case ids must be unique'),
});

export interface CheckResult {
  name: string;
  pass: boolean;
  /** A warning when it fails, not a failure. */
  soft: boolean;
  detail: string;
}

export interface JudgeResult {
  score: number | null;
  summary: string;
  criteria: Array<{ criterion: string; pass: boolean; reason: string }>;
}

export interface CaseToolCall {
  turn: number;
  name: string;
  input: unknown;
  resultChars: number;
  isError: boolean;
}

export interface CaseResult {
  id: string;
  title: string;
  checks: string;
  /** The project the case ran in. */
  projectName?: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  /** Why a case was skipped or errored. */
  reason: string | null;
  /** Placeholder values this run used, e.g. { "book_piece:a": "Tunnels" }. */
  resolved: Record<string, string>;
  transcript: Array<{ role: 'writer' | 'quinn'; text: string }>;
  toolCalls: CaseToolCall[];
  results: CheckResult[];
  judge: JudgeResult | null;
  model: string | null;
  effort: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  ms: number;
}
