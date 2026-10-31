import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { config } from '../config.js';
import { formatWriterDate, formatWriterTime } from '../utils/time.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskType =
  | 'coaching'
  | 'editorial'
  | 'theme_analysis'
  | 'intelligence'
  | 'nudge'
  | 'corpus_analysis'
  | 'promptly_coaching'
  | 'central_question_evaluation';

/**
 * Logical model slots. 'haiku' is for background work (intelligence curation,
 * nudges) and is never chosen by determineModel for coaching.
 */
export type ModelSelection = 'sonnet' | 'opus' | 'haiku';

/**
 * How much work the model puts into a response, including how much it thinks.
 * Sent as output_config.effort. Current models think adaptively by default, and
 * thinking tokens count toward max_tokens and are billed as output.
 */
export type Effort = 'low' | 'medium' | 'high';

export type ModelRoutingPreference = 'always_sonnet' | 'always_opus' | 'auto';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeResponse {
  content: string;
  model: ModelSelection;
  reason: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRoutingDecision {
  model: ModelSelection;
  reason: string;
}

export interface ContextMetadata {
  corpusDocCount: number;
  historicalPostCount: number;
  taskType: TaskType;
}

export interface SendMessageOptions {
  systemPrompt: string;
  messages: ClaudeMessage[];
  model: ModelSelection;
  /** Defaults to 'low': non-streaming calls are background or short tasks. */
  effort?: Effort;
  /** Ceiling on output, thinking included. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  onStream?: (token: string) => void;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
});

/**
 * Model IDs per slot. Override with env vars in Railway if needed; if you do,
 * pick a model that accepts output_config.effort, and update PRICING in
 * usage-tracking.service.ts so cost estimates stay right.
 */
const MODEL_MAP: Record<ModelSelection, string> = {
  sonnet: process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-5-5',
  opus: process.env.CLAUDE_OPUS_MODEL || 'claude-opus-5-5',
  haiku: process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-5-5',
};

/** Output ceiling for non-streaming calls. Thinking counts toward it. */
const DEFAULT_MAX_TOKENS = 8000;

/**
 * Output ceiling for streamed coaching replies. Deep workflows at high effort
 * can think for several thousand tokens before writing a long reply, so this is
 * well above the old 4,096 cap. It's a ceiling, not a target: billing follows
 * the tokens actually generated.
 */
const COACHING_MAX_TOKENS = 16000;

/** Join every text block; with thinking on, the first block may not be text. */
function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Send a message to Claude with optional streaming support.
 * When onStream callback is provided, tokens are streamed as they arrive.
 * Always returns the complete response with token usage.
 */
export async function sendMessage(
  options: SendMessageOptions
): Promise<ClaudeResponse> {
  const { systemPrompt, messages, model, onStream } = options;
  const modelId = MODEL_MAP[model];
  const effort: Effort = options.effort ?? 'low';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (onStream) {
    // Streaming mode
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = anthropic.messages.stream({
      model: modelId,
      max_tokens: maxTokens,
      output_config: { effort },
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    stream.on('text', (text) => {
      fullContent += text;
      onStream(text);
    });

    const finalMessage = await stream.finalMessage();
    inputTokens = finalMessage.usage.input_tokens;
    outputTokens = finalMessage.usage.output_tokens;

    return {
      content: fullContent,
      model,
      reason: '',
      inputTokens,
      outputTokens,
    };
  } else {
    // Non-streaming mode
    const response = await anthropic.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      output_config: { effort },
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = extractText(response.content);
    if (!content) {
      console.warn(
        `[Claude] ${modelId} returned no text (stop_reason: ${response.stop_reason}, output tokens: ${response.usage.output_tokens})`
      );
    }

    return {
      content,
      model,
      reason: '',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

/**
 * Pipe Anthropic stream events to an Express Response as Server-Sent Events.
 * Sends events: 'token', 'model_info', 'retrying', 'done', 'error'.
 *
 * Resolves with empty content (after sending an 'error' event) when the model
 * produced no text, e.g. thinking used the whole output budget or the model
 * declined. Callers should log usage but not persist an empty reply.
 */
export function streamToSSE(
  res: Response,
  options: {
    systemPrompt: string;
    messages: ClaudeMessage[];
    model: ModelSelection;
    modelReason: string;
    effort: Effort;
  }
): { promise: Promise<ClaudeResponse>; abort: () => void } {
  const { systemPrompt, messages, model, modelReason, effort } = options;
  const modelId = MODEL_MAP[model];

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send model info event
  res.write(
    `event: model_info\ndata: ${JSON.stringify({ model, reason: modelReason })}\n\n`
  );

  let aborted = false;
  let finished = false;
  let currentStream: ReturnType<typeof anthropic.messages.stream> | null = null;

  // The model can think for a while before its first token. An SSE comment
  // every 15s keeps proxies from treating the quiet connection as idle; the
  // client ignores comment lines.
  const keepAlive = setInterval(() => {
    if (!finished && !res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);
  res.on('close', () => clearInterval(keepAlive));

  /** Write an optional final event and end the response, exactly once. */
  function finish(event?: { name: 'done' | 'error'; data: unknown }): void {
    if (finished) return;
    finished = true;
    clearInterval(keepAlive);
    if (res.writableEnded) return;
    if (event) {
      res.write(`event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
    res.end();
  }

  /**
   * Determine if an error is transient and worth retrying.
   * Overloaded (529), rate limit (429), and server errors (5xx) are transient.
   */
  function isRetryableError(error: unknown): boolean {
    const err = error as { status?: number; error?: { type?: string }; message?: string };
    if (err?.status === 529 || err?.status === 429 || (err?.status && err.status >= 500)) {
      return true;
    }
    const errorType = err?.error?.type || '';
    if (errorType === 'overloaded_error' || errorType === 'api_error' || errorType === 'rate_limit_error') {
      return true;
    }
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('timeout');
  }

  const MAX_RETRIES = 4;

  const promise = new Promise<ClaudeResponse>((resolve, reject) => {
    let fullContent = '';

    /**
     * Attempt the stream. If it fails before any text is emitted with a
     * retryable error, wait with exponential backoff and try again.
     */
    async function attempt(retryCount: number): Promise<void> {
      if (aborted || finished) return;

      let streamedAnyText = false;
      // The SDK emits 'end' right after 'error'. This flag tells the 'end'
      // handler that the error handler already decided this attempt's outcome
      // (retry or fail), so it must not report anything itself.
      let failed = false;
      const stream = anthropic.messages.stream({
        model: modelId,
        max_tokens: COACHING_MAX_TOKENS,
        output_config: { effort },
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
      currentStream = stream;

      stream.on('text', (text) => {
        if (aborted || finished) return;
        streamedAnyText = true;
        fullContent += text;
        res.write(`event: token\ndata: ${JSON.stringify({ token: text })}\n\n`);
      });

      stream.on('error', (error) => {
        failed = true;
        if (aborted || finished) return;

        // If we can still retry and nothing has been streamed yet, back off and retry
        if (!streamedAnyText && retryCount < MAX_RETRIES && isRetryableError(error)) {
          const delayMs = Math.min(1000 * Math.pow(2, retryCount), 8000);
          console.warn(
            `[Claude] Transient error (${(error as Error).message}). Retry ${retryCount + 1}/${MAX_RETRIES} in ${delayMs}ms`
          );
          // Let the client know we're retrying so the UI can show a status
          res.write(
            `event: retrying\ndata: ${JSON.stringify({ attempt: retryCount + 1, delayMs })}\n\n`
          );
          setTimeout(() => {
            void attempt(retryCount + 1);
          }, delayMs);
          return;
        }

        // Out of retries or already streaming — surface the error
        const friendlyMessage = isRetryableError(error)
          ? 'Quinn is experiencing high demand right now. Please try again in a moment.'
          : (error as Error).message;
        finish({ name: 'error', data: { message: friendlyMessage } });
        reject(error);
      });

      stream.on('end', () => {
        if (failed || aborted || finished) return;
        // Wait for finalMessage to get token counts
        stream
          .finalMessage()
          .then((finalMessage) => {
            if (aborted || finished) return;

            const response: ClaudeResponse = {
              content: fullContent,
              model,
              reason: modelReason,
              inputTokens: finalMessage.usage.input_tokens,
              outputTokens: finalMessage.usage.output_tokens,
            };

            if (finalMessage.stop_reason === 'max_tokens') {
              console.warn(
                `[Claude] ${modelId} hit max_tokens (${COACHING_MAX_TOKENS}) at effort ${effort}`
              );
            }

            if (!fullContent.trim()) {
              console.warn(
                `[Claude] ${modelId} returned no text (stop_reason: ${finalMessage.stop_reason}, output tokens: ${response.outputTokens})`
              );
              const message =
                finalMessage.stop_reason === 'refusal'
                  ? "Quinn couldn't respond to that one. Try rephrasing it."
                  : "Quinn didn't finish a reply that time. Please try again.";
              finish({ name: 'error', data: { message } });
              resolve(response);
              return;
            }

            finish({
              name: 'done',
              data: { inputTokens: response.inputTokens, outputTokens: response.outputTokens },
            });
            resolve(response);
          })
          .catch((err) => {
            if (aborted || finished) return;
            finish({ name: 'error', data: { message: (err as Error).message } });
            reject(err);
          });
      });
    }

    void attempt(0);
  });

  const abort = () => {
    aborted = true;
    if (currentStream) currentStream.abort();
    finish();
  };

  return { promise, abort };
}


// ─── Smart Model Routing ─────────────────────────────────────────────────────

/**
 * Determine which Claude model to use based on task type and context.
 *
 * Routing rules:
 * - Sonnet: coaching, nudge, intelligence, simple editorial
 * - Opus: deep corpus analysis (>5 docs), theme mapping,
 *         central question evaluation, Promptly coaching with 3+ historical posts
 *
 * User override from settings takes precedence over auto-routing.
 */
export function determineModel(
  taskType: TaskType,
  context: ContextMetadata,
  userPreference: ModelRoutingPreference = 'auto'
): ModelRoutingDecision {
  // User override takes precedence
  if (userPreference === 'always_sonnet') {
    return {
      model: 'sonnet',
      reason: 'User preference set to always use Sonnet',
    };
  }

  if (userPreference === 'always_opus') {
    return {
      model: 'opus',
      reason: 'User preference set to always use Opus',
    };
  }

  // Auto-routing logic
  switch (taskType) {
    case 'corpus_analysis':
      if (context.corpusDocCount > 5) {
        return {
          model: 'opus',
          reason: `Deep corpus analysis with ${context.corpusDocCount} documents requires Opus for comprehensive understanding`,
        };
      }
      return {
        model: 'sonnet',
        reason: `Corpus analysis with ${context.corpusDocCount} documents is manageable with Sonnet`,
      };

    case 'theme_analysis':
      return {
        model: 'opus',
        reason: 'Cross-project theme mapping requires Opus for nuanced pattern recognition',
      };

    case 'central_question_evaluation':
      return {
        model: 'opus',
        reason: 'Central question evaluation requires Opus for deep literary analysis',
      };

    case 'promptly_coaching':
      if (context.historicalPostCount >= 3) {
        return {
          model: 'opus',
          reason: `Promptly coaching with ${context.historicalPostCount} historical posts requires Opus for pattern analysis`,
        };
      }
      return {
        model: 'sonnet',
        reason: `Promptly coaching with ${context.historicalPostCount} historical posts is manageable with Sonnet`,
      };

    case 'coaching':
      return {
        model: 'sonnet',
        reason: 'Everyday coaching conversations use Sonnet for responsive dialogue',
      };

    case 'editorial':
      return {
        model: 'sonnet',
        reason: 'Simple editorial feedback uses Sonnet for quick turnaround',
      };

    case 'nudge':
      return {
        model: 'sonnet',
        reason: 'Nudge generation uses Sonnet for efficient, brief outputs',
      };

    case 'intelligence':
      return {
        model: 'sonnet',
        reason: 'Intelligence curation uses Sonnet for efficient processing',
      };

    default:
      return {
        model: 'sonnet',
        reason: 'Default routing to Sonnet for unrecognized task type',
      };
  }
}


// ─── System Prompt Assembly ──────────────────────────────────────────────────

/**
 * System-prompt budget per model, in characters. The 5.x models' tokenizer
 * averages roughly 3 characters per token for prose, so 128k chars is about
 * 40k tokens and 256k about 85k.
 */
const TOKEN_BUDGET: Record<ModelSelection, number> = {
  sonnet: 32000 * 4, // 128k chars
  opus: 64000 * 4, // 256k chars
  haiku: 32000 * 4, // not used for coaching prompts
};

export interface ProjectContext {
  name: string;
  centralQuestion: string | null;
  description: string | null;
}

export interface SessionSummary {
  summary: string | null;
  nextSteps: string | null;
  startedAt: Date;
}

export interface AssemblePromptOptions {
  personaConfig: Record<string, unknown>;
  projectContext: ProjectContext;
  manuscriptMap: string | null;
  firstRightsContext: string | null;
  workflowContext: string | null;
  commandContext: string | null;
  sessionHistories: SessionSummary[];
  /** Set when early messages of the current session were left out of the request. */
  conversationNote?: string | null;
  corpusContext: string[];
  activityContext: string | null;
  taskInstructions: string;
  ethicsPrompt: string;
  model: ModelSelection;
}

/**
 * Truncate text to fit within a character budget.
 */
function truncateToFit(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return text.slice(0, budget - 3) + '...';
}

/**
 * Assemble the full system prompt for a Claude API request.
 *
 * Includes:
 * - Persona configuration (identity, voice, principles, expertise, ethics)
 * - Project context (name, central question, description)
 * - Session history summaries (recent ended sessions)
 * - A note when early messages of this session were left out
 * - Relevant corpus context (truncated to the character budget)
 * - Activity context
 * - Task-specific instructions
 * - Ethics enforcement
 *
 * Character budget per model: see TOKEN_BUDGET.
 */
export function assembleSystemPrompt(options: AssemblePromptOptions): string {
  const {
    personaConfig,
    projectContext,
    manuscriptMap,
    firstRightsContext,
    workflowContext,
    commandContext,
    sessionHistories,
    conversationNote,
    corpusContext,
    activityContext,
    taskInstructions,
    ethicsPrompt,
    model,
  } = options;

  const budget = TOKEN_BUDGET[model];
  const sections: string[] = [];

  // 0. Current date/time context, in the writer's time zone (the server runs in UTC)
  const now = new Date();
  sections.push(`## Current Date and Time\n${formatWriterDate(now)}, ${formatWriterTime(now)} (the writer's local time)\n\nUse this naturally in conversation when relevant — acknowledge gaps between sessions, reference time of day, etc.`);

  // 1. Persona configuration
  const personaSection = buildPersonaSection(personaConfig);
  sections.push(personaSection);

  // 2. Ethics enforcement (always included)
  sections.push(`## Ethics Enforcement\n${ethicsPrompt}`);

  // 3. Project context
  const projectSection = buildProjectSection(projectContext);
  sections.push(projectSection);

  // 3a. First-publication rights — pieces reserved for journal submission, and
  // any apparent Substack collisions. Placed before the map so the constraint is
  // read before Quinn reasons about the manuscript.
  if (firstRightsContext) {
    sections.push(firstRightsContext);
  }

  // 3b. Manuscript structure map (full Scrivener binder — always included so
  // Quinn knows everything that exists and where, regardless of corpus excerpts)
  if (manuscriptMap) {
    sections.push(
      `## Manuscript Structure (Scrivener binder)\nThis is the writer's complete Scrivener binder as of the latest sync — your map of what exists and where. Indentation shows folder nesting; word counts reflect the most recent sync. Folder roles: [DRAFT] is the live manuscript, [RESEARCH] is notes/source material, [TRASH] is deleted (ignore unless the writer asks). Use this to locate and reference specific pieces accurately. Never claim a piece doesn't exist if it appears here, and don't invent pieces that don't.\n\n${manuscriptMap}`
    );
  }

  // 4. Session history summaries (recent ended sessions)
  if (sessionHistories.length > 0) {
    const historySection = buildSessionHistorySection(sessionHistories);
    sections.push(historySection);
  }

  // 4b. Honest note when this session's early messages aren't in the request
  if (conversationNote) {
    sections.push(`## Earlier in This Session\n${conversationNote}`);
  }

  // 5. Activity context
  if (activityContext) {
    sections.push(`## Recent Activity\n${activityContext}`);
  }

  // 6. Task-specific instructions
  sections.push(`## Current Task Instructions\n${taskInstructions}`);

  // 6b. Active workflow (if running) — this takes precedence over the general
  // task instructions: Quinn should focus on the current step only.
  if (workflowContext) {
    sections.push(workflowContext);
  }

  // 6c. One-shot prompt command (Analyze, Central Question, etc.) for this turn.
  if (commandContext) {
    sections.push(commandContext);
  }

  // Calculate remaining budget for corpus context
  const currentLength = sections.join('\n\n').length;
  const remainingBudget = Math.max(0, budget - currentLength - 200); // 200 char buffer

  // 7. Corpus context (truncated to remaining budget)
  if (corpusContext.length > 0 && remainingBudget > 100) {
    const corpusSection = buildCorpusSection(corpusContext, remainingBudget);
    sections.push(corpusSection);
  }

  return sections.join('\n\n');
}

function buildPersonaSection(personaConfig: Record<string, unknown>): string {
  const lines: string[] = ['## Persona'];

  const name = personaConfig['name'] as string | undefined;
  if (name) {
    lines.push(`You are ${name}.`);
  }

  const identity = personaConfig['identity'] as Record<string, unknown> | undefined;
  if (identity) {
    if (identity['role']) lines.push(`Role: ${identity['role']}`);
    if (identity['background']) lines.push(`Background: ${identity['background']}`);
  }

  const voice = personaConfig['voice'] as Record<string, unknown> | undefined;
  if (voice) {
    if (voice['tone']) lines.push(`Tone: ${voice['tone']}`);

    const edge = voice['the_edge_does_what'] as string[] | undefined;
    if (edge && edge.length > 0) {
      lines.push(
        `\nWhat the edge in your voice does in practice:\n${edge.map((e) => `- ${e}`).join('\n')}`
      );
    }

    const patterns = voice['communication_patterns'] as string[] | undefined;
    if (patterns && patterns.length > 0) {
      lines.push(
        `\nCommunication patterns:\n${patterns.map((p) => `- ${p}`).join('\n')}`
      );
    }

    const partnership = voice['partnership_language'] as string[] | undefined;
    if (partnership && partnership.length > 0) {
      lines.push(`\nPartnership language to reach for: ${partnership.join('; ')}`);
    }
  }

  const principles = personaConfig['principles'] as string[] | undefined;
  if (principles && principles.length > 0) {
    lines.push(`\nPrinciples:\n${principles.map((p) => `- ${p}`).join('\n')}`);
  }

  const expertise = personaConfig['expertise'] as Record<string, unknown> | undefined;
  if (expertise) {
    const literary = expertise['literary_knowledge'] as string[] | undefined;
    if (literary && literary.length > 0) {
      lines.push(`\nLiterary knowledge: ${literary.join(', ')}`);
    }

    if (expertise['north_star_author']) {
      lines.push(`North star author: ${expertise['north_star_author']}`);
    }

    const craftPrinciples = expertise['craft_principles'] as string[] | undefined;
    if (craftPrinciples && craftPrinciples.length > 0) {
      lines.push(
        `\nCraft principles (apply lightly to non-literary work like AI journalism):\n${craftPrinciples.map((c) => `- ${c}`).join('\n')}`
      );
    }

    const techniques = expertise['techniques_to_invoke'] as string[] | undefined;
    if (techniques && techniques.length > 0) {
      lines.push(
        `\nTechniques to invoke when a draft would benefit (tools, not rules):\n${techniques.map((t) => `- ${t}`).join('\n')}`
      );
    }
  }

  const ethics = personaConfig['ethics'] as Record<string, unknown> | undefined;
  if (ethics) {
    const familyQuestions = ethics['family_privacy_questions'] as string[] | undefined;
    if (familyQuestions && familyQuestions.length > 0) {
      lines.push(
        `\nWhen the writer is wrestling with what is writable about family, do not rule. Offer these questions:\n${familyQuestions.map((q) => `- ${q}`).join('\n')}`
      );
    }
    const releaseValve = ethics['family_privacy_release_valve'] as string | undefined;
    if (releaseValve) {
      lines.push(releaseValve);
    }
  }

  const failureModes = personaConfig['failure_modes'] as string[] | undefined;
  if (failureModes && failureModes.length > 0) {
    lines.push(
      `\nDrift signals — what going wrong looks like. If you notice these patterns in yourself, course-correct:\n${failureModes.map((f) => `- ${f}`).join('\n')}`
    );
  }

  const kevinProfile = personaConfig['kevin_profile'] as Record<string, unknown> | undefined;
  if (kevinProfile) {
    const writerStyle = kevinProfile['writer_style'] as string[] | undefined;
    if (writerStyle && writerStyle.length > 0) {
      lines.push(
        `\nThe writer's style (what to preserve):\n${writerStyle.map((s) => `- ${s}`).join('\n')}`
      );
    }

    const writerContext = kevinProfile['context'] as string[] | undefined;
    if (writerContext && writerContext.length > 0) {
      lines.push(
        `\nAbout the writer (background you already know; don't make them repeat it):\n${writerContext.map((c) => `- ${c}`).join('\n')}`
      );
    }
  }

  if (identity) {
    const signature = identity['partnership_signature'] as string | undefined;
    if (signature) {
      lines.push(`\nSession sign-off: "${signature}" — use this ONLY as a farewell when the writer is clearly ending their session or saying goodbye. Never after individual responses mid-conversation.`);
    }
  }

  return lines.join('\n');
}

function buildProjectSection(project: ProjectContext): string {
  const lines: string[] = ['## Active Project'];
  lines.push(`Project: ${project.name}`);
  if (project.centralQuestion) {
    lines.push(`Central Question: ${project.centralQuestion}`);
  }
  if (project.description) {
    lines.push(`Description: ${project.description}`);
  }
  lines.push(
    '\nThe writer selected this project in the navigation when they started this session. Treat it as the working context. However, if their message clearly concerns a different one of their projects — not just a passing reference, but the substantive subject of what they are asking about — surface that observation and ask whether they meant to switch, rather than silently coaching them in the wrong frame.'
  );
  return lines.join('\n');
}

function buildSessionHistorySection(sessions: SessionSummary[]): string {
  const lines: string[] = ['## Session Memory'];
  lines.push(
    "These are your notes from previous sessions with this writer, most recent first. They're what you remember: you have these notes, not the full conversations, so if the writer asks about a detail that isn't here, say you don't have it rather than guessing. When starting a new session, naturally acknowledge where you left off — reference specific topics, decisions, or unresolved threads. Do not recite the summaries verbatim; weave them into conversation as a coach who remembers would."
  );

  for (const session of sessions) {
    const date = formatWriterDate(session.startedAt);
    lines.push(`\n### Session — ${date}`);
    if (session.summary) {
      lines.push(`What happened: ${session.summary}`);
    }
    if (session.nextSteps) {
      lines.push(`What was next: ${session.nextSteps}`);
    }
  }
  return lines.join('\n');
}

function buildCorpusSection(
  corpusContext: string[],
  budget: number
): string {
  const header = '## Relevant Corpus Context\n';
  let content = '';
  let remaining = budget - header.length;

  for (const doc of corpusContext) {
    if (remaining <= 0) break;
    const entry = doc + '\n\n';
    if (entry.length <= remaining) {
      content += entry;
      remaining -= entry.length;
    } else {
      content += truncateToFit(doc, remaining);
      break;
    }
  }

  return header + content;
}
