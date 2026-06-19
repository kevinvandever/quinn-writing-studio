import Anthropic from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { config } from '../config.js';

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

export type ModelSelection = 'sonnet' | 'opus';

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
  onStream?: (token: string) => void;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
});

const MODEL_MAP: Record<ModelSelection, string> = {
  sonnet: process.env.CLAUDE_SONNET_MODEL || 'claude-sonnet-4-6',
  opus: process.env.CLAUDE_OPUS_MODEL || 'claude-opus-4-8',
};

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

  if (onStream) {
    // Streaming mode
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = anthropic.messages.stream({
      model: modelId,
      max_tokens: 4096,
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
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock ? textBlock.text : '';

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
 * Sends events: 'token', 'model_info', 'done', 'error'
 */
export function streamToSSE(
  res: Response,
  options: {
    systemPrompt: string;
    messages: ClaudeMessage[];
    model: ModelSelection;
    modelReason: string;
  }
): { promise: Promise<ClaudeResponse>; abort: () => void } {
  const { systemPrompt, messages, model, modelReason } = options;
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
  let currentStream: ReturnType<typeof anthropic.messages.stream> | null = null;

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
      if (aborted) return;

      let streamedAnyText = false;
      const stream = anthropic.messages.stream({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
      currentStream = stream;

      stream.on('text', (text) => {
        if (aborted) return;
        streamedAnyText = true;
        fullContent += text;
        res.write(`event: token\ndata: ${JSON.stringify({ token: text })}\n\n`);
      });

      stream.on('error', async (error) => {
        if (aborted) return;

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
            if (!aborted) attempt(retryCount + 1);
          }, delayMs);
          return;
        }

        // Out of retries or already streaming — surface the error
        const friendlyMessage = isRetryableError(error)
          ? 'Quinn is experiencing high demand right now. Please try again in a moment.'
          : (error as Error).message;
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: friendlyMessage })}\n\n`
        );
        res.end();
        reject(error);
      });

      stream.on('end', () => {
        // Wait for finalMessage to get token counts
        stream
          .finalMessage()
          .then((finalMessage) => {
            if (aborted) return;

            const response: ClaudeResponse = {
              content: fullContent,
              model,
              reason: modelReason,
              inputTokens: finalMessage.usage.input_tokens,
              outputTokens: finalMessage.usage.output_tokens,
            };

            res.write(
              `event: done\ndata: ${JSON.stringify({ inputTokens: response.inputTokens, outputTokens: response.outputTokens })}\n\n`
            );
            res.end();
            resolve(response);
          })
          .catch((err) => {
            if (aborted) return;
            res.write(
              `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`
            );
            res.end();
            reject(err);
          });
      });
    }

    attempt(0);
  });

  const abort = () => {
    aborted = true;
    if (currentStream) currentStream.abort();
    res.end();
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

/** Token budget per model (approximate characters, ~4 chars per token) */
const TOKEN_BUDGET: Record<ModelSelection, number> = {
  sonnet: 32000 * 4, // 32k tokens ≈ 128k chars
  opus: 64000 * 4, // 64k tokens ≈ 256k chars
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
  sessionHistories: SessionSummary[];
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
 * - Session history summaries (last 3 sessions)
 * - Relevant corpus context (truncated to token budget)
 * - Activity context
 * - Task-specific instructions
 * - Ethics enforcement
 *
 * Configurable token budget: 8k for Sonnet, 16k for Opus
 */
export function assembleSystemPrompt(options: AssemblePromptOptions): string {
  const {
    personaConfig,
    projectContext,
    manuscriptMap,
    sessionHistories,
    corpusContext,
    activityContext,
    taskInstructions,
    ethicsPrompt,
    model,
  } = options;

  const budget = TOKEN_BUDGET[model];
  const sections: string[] = [];

  // 0. Current date/time context
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  sections.push(`## Current Date and Time\n${dateStr}, ${timeStr}\n\nUse this naturally in conversation when relevant — acknowledge gaps between sessions, reference time of day, etc.`);

  // 1. Persona configuration
  const personaSection = buildPersonaSection(personaConfig);
  sections.push(personaSection);

  // 2. Ethics enforcement (always included)
  sections.push(`## Ethics Enforcement\n${ethicsPrompt}`);

  // 3. Project context
  const projectSection = buildProjectSection(projectContext);
  sections.push(projectSection);

  // 3b. Manuscript structure map (full Scrivener binder — always included so
  // Quinn knows everything that exists and where, regardless of corpus excerpts)
  if (manuscriptMap) {
    sections.push(
      `## Manuscript Structure (Scrivener binder)\nThis is the writer's complete Scrivener binder as of the latest sync — your map of what exists and where. Indentation shows folder nesting; word counts reflect the most recent sync. Folder roles: [DRAFT] is the live manuscript, [RESEARCH] is notes/source material, [TRASH] is deleted (ignore unless the writer asks). Use this to locate and reference specific pieces accurately. Never claim a piece doesn't exist if it appears here, and don't invent pieces that don't.\n\n${manuscriptMap}`
    );
  }

  // 4. Session history summaries (last 3)
  if (sessionHistories.length > 0) {
    const historySection = buildSessionHistorySection(sessionHistories);
    sections.push(historySection);
  }

  // 5. Activity context
  if (activityContext) {
    sections.push(`## Recent Activity\n${activityContext}`);
  }

  // 6. Task-specific instructions
  sections.push(`## Current Task Instructions\n${taskInstructions}`);

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
    'These are your memories of previous sessions with this writer. You remember these conversations. When starting a new session, naturally acknowledge where you left off — reference specific topics, decisions, or unresolved threads. Do not recite the summaries verbatim; weave them into conversation as a coach who remembers would.'
  );

  for (const session of sessions.slice(0, 3)) {
    const date = session.startedAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
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
