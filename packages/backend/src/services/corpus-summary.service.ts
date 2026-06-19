/**
 * Corpus Summary Service
 *
 * Generates a compact per-document index — a 2-3 sentence logline plus a few
 * themes — for every non-folder corpus document, and stores it in the
 * document's `metadata` jsonb (alongside `scrivenerType`). No schema change.
 *
 * Why: the full text of a 100k-word collection can't fit in a single context
 * window, so collection-level coaching ("which piece is strongest for X",
 * triage, sequencing) needs a substantive-but-small representation of EVERY
 * piece. The manuscript map renders these loglines so Quinn can reason across
 * the whole collection, not just the dozen pieces whose full text happens to
 * be loaded for a given turn.
 *
 * Summaries are keyed by content_hash, so a piece is only re-summarized when
 * its text actually changes.
 */
import { query } from '../db/connection.js';
import { sendMessage, type ModelSelection } from './claude-api.service.js';
import { logApiUsage } from './usage-tracking.service.js';

// In-memory guard so we never run two summary passes for the same project at once.
const inFlight = new Set<string>();

interface SummaryResult {
  summary: string;
  themes: string[];
}

/**
 * Extract a JSON object from a Claude response that may be wrapped in prose
 * or a markdown code fence.
 */
function extractJSON(content: string): string {
  const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return content;
}

/**
 * Generate a logline + themes for a single document's text.
 */
async function summarizeDocument(
  title: string,
  content: string
): Promise<{ result: SummaryResult; inputTokens: number; outputTokens: number; model: ModelSelection } | null> {
  // Cap the text we send — the opening and a tail are plenty to characterize a piece.
  const excerpt = content.length > 8000 ? content.slice(0, 8000) : content;

  const response = await sendMessage({
    systemPrompt: `You index a writer's manuscript. Given one piece, produce a compact entry another coach can scan.

Return ONLY JSON: {"summary": "...", "themes": ["...", "..."]}

- summary: 2-3 sentences. What the piece is about, its central move or tension, and its tone. Concrete, not generic. Name people/places/events that anchor it.
- themes: 3-6 short theme tags (e.g. "fatherhood", "addiction", "memory", "dark humor").

No preamble, no markdown, just the JSON object.`,
    messages: [
      {
        role: 'user',
        content: `Title: ${title}\n\n${excerpt}`,
      },
    ],
    model: 'sonnet' as ModelSelection,
  });

  try {
    const parsed = JSON.parse(extractJSON(response.content)) as Partial<SummaryResult>;
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const themes = Array.isArray(parsed.themes)
      ? parsed.themes.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];
    if (!summary) return null;
    return {
      result: { summary, themes },
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      model: response.model,
    };
  } catch {
    return null;
  }
}

/**
 * Ensure every non-folder document in a project has an up-to-date summary in
 * its metadata. Skips documents whose summary already matches the current
 * content_hash. Designed to be called fire-and-forget (after an import, or when
 * a coaching session starts); failures are logged, never thrown.
 *
 * @param maxDocs safety cap on how many summaries to generate per invocation.
 */
export async function ensureCorpusSummaries(
  projectId: string,
  userId: string,
  maxDocs = 60
): Promise<void> {
  if (inFlight.has(projectId)) return;
  inFlight.add(projectId);

  try {
    // Find documents that need a summary (missing, or stale vs current content).
    const stale = await query<{
      id: string;
      title: string;
      content: string;
      content_hash: string | null;
    }>(
      `SELECT id, title, content, content_hash
       FROM corpus_documents
       WHERE project_id = $1
         AND is_folder = false
         AND content != ''
         AND (
           metadata->>'summary' IS NULL
           OR metadata->>'summaryHash' IS DISTINCT FROM content_hash
         )
       ORDER BY word_count DESC NULLS LAST
       LIMIT $2`,
      [projectId, maxDocs]
    );

    if (stale.rows.length === 0) return;

    console.log(`[CorpusSummary] Generating ${stale.rows.length} summaries for project ${projectId}`);

    for (const doc of stale.rows) {
      try {
        const summarized = await summarizeDocument(doc.title || 'Untitled', doc.content);
        if (!summarized) continue;

        await query(
          `UPDATE corpus_documents
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
           WHERE id = $1`,
          [
            doc.id,
            JSON.stringify({
              summary: summarized.result.summary,
              themes: summarized.result.themes,
              summaryHash: doc.content_hash ?? null,
            }),
          ]
        );

        await logApiUsage(
          userId,
          summarized.model,
          'corpus_analysis',
          summarized.inputTokens,
          summarized.outputTokens
        );
      } catch (err) {
        console.warn(
          `[CorpusSummary] Failed to summarize "${doc.title}":`,
          err instanceof Error ? err.message : err
        );
        // Continue with the rest — one bad doc shouldn't stop the pass.
      }
    }

    console.log(`[CorpusSummary] Done for project ${projectId}`);
  } catch (err) {
    console.error(
      '[CorpusSummary] Summary pass failed:',
      err instanceof Error ? err.message : err
    );
  } finally {
    inFlight.delete(projectId);
  }
}
