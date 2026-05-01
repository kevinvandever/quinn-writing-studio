import { query } from '../db/connection.js';

// ─── Ethics Enforcement Text ─────────────────────────────────────────────────

const ETHICS_ENFORCEMENT_TEXT = `CRITICAL ETHICS BOUNDARY — WRITING COACH ETHICS:

You are a writing coach, NOT a ghostwriter. You must NEVER generate original creative prose, essays, or paragraphs on the user's behalf.

ALLOWED outputs:
- Suggestions and recommendations
- Questions that draw out the writer's own insights
- Flags and observations about the writing (e.g., "this section feels preachy")
- Analysis of themes, structure, and craft
- Structural recommendations (e.g., "consider reordering these sections")
- Brief technique examples (1-2 sentences max, clearly labeled as examples)
- Summaries of what the writer has already written
- Editorial feedback (show vs tell, voice consistency, pacing)

FORBIDDEN outputs:
- Original paragraphs, essays, or creative prose written for the user
- Completing the user's sentences or paragraphs
- Drafting sections of essays or stories
- Rewriting the user's work (suggest changes, don't make them)
- Generating content that could be directly published as the user's work

If the user asks you to write something for them, redirect to coaching:
- "I'd love to help you think through this. What's the core feeling you want to convey?"
- "Rather than writing it for you, let me ask: what's the one thing you want the reader to walk away with?"
- "That's your voice to find. Let's talk about what's blocking you from getting it on the page."`;

// ─── Violation Detection Patterns ────────────────────────────────────────────

/**
 * Heuristic patterns that suggest Quinn may have generated original prose.
 * These are conservative checks — false positives are preferred over missed violations.
 */
const VIOLATION_INDICATORS = [
  // Phrases that suggest Quinn is writing prose for the user
  /here(?:'s| is) (?:a |an |the )?(?:draft|paragraph|essay|section|opening|passage)/i,
  /i(?:'ve| have) written (?:a |an |the )?(?:draft|paragraph|essay|section|opening)/i,
  /here(?:'s| is) what (?:that|it|this) (?:could|might|would) look like/i,
  /let me write (?:that|this|it) for you/i,
  /here(?:'s| is) (?:my|a) (?:version|take|attempt)/i,
];

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Returns the ethics enforcement text to inject into every system prompt.
 */
export function getEthicsPrompt(): string {
  return ETHICS_ENFORCEMENT_TEXT;
}

/**
 * Basic heuristic check for potential ethics violations in Quinn's response.
 * Returns true if the response may contain original prose written for the user.
 *
 * This is a conservative check — it may produce false positives.
 * Violations should be logged for human review rather than blocking responses.
 */
export function checkEthicsViolation(response: string): boolean {
  return VIOLATION_INDICATORS.some((pattern) => pattern.test(response));
}

/**
 * Log an ethics boundary invocation to the ethics_logs table.
 * Called when a potential ethics violation is detected in Quinn's response.
 */
export async function logEthicsBoundary(
  userId: string,
  sessionId: string,
  userMessage: string,
  quinnResponse: string
): Promise<void> {
  await query(
    `INSERT INTO ethics_logs (user_id, session_id, user_message, quinn_response)
     VALUES ($1, $2, $3, $4)`,
    [userId, sessionId, userMessage, quinnResponse]
  );
}
