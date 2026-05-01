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
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
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

  const stream = anthropic.messages.stream({
    model: modelId,
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const promise = new Promise<ClaudeResponse>((resolve, reject) => {
    let fullContent = '';

    stream.on('text', (text) => {
      if (aborted) return;
      fullContent += text;
      res.write(`event: token\ndata: ${JSON.stringify({ token: text })}\n\n`);
    });

    stream.on('error', (error) => {
      if (aborted) return;
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`
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
  });

  const abort = () => {
    aborted = true;
    stream.abort();
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
  sonnet: 8000 * 4, // 8k tokens ≈ 32k chars
  opus: 16000 * 4, // 16k tokens ≈ 64k chars
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
    sessionHistories,
    corpusContext,
    activityContext,
    taskInstructions,
    ethicsPrompt,
    model,
  } = options;

  const budget = TOKEN_BUDGET[model];
  const sections: string[] = [];

  // 1. Persona configuration
  const personaSection = buildPersonaSection(personaConfig);
  sections.push(personaSection);

  // 2. Ethics enforcement (always included)
  sections.push(`## Ethics Enforcement\n${ethicsPrompt}`);

  // 3. Project context
  const projectSection = buildProjectSection(projectContext);
  sections.push(projectSection);

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
    const patterns = voice['communication_patterns'] as string[] | undefined;
    if (patterns && patterns.length > 0) {
      lines.push(`Communication patterns: ${patterns.join('; ')}`);
    }
    const partnership = voice['partnership_language'] as string[] | undefined;
    if (partnership && partnership.length > 0) {
      lines.push(`Partnership language: ${partnership.join('; ')}`);
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
      lines.push(`Craft principles: ${craftPrinciples.join('; ')}`);
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
  return lines.join('\n');
}

function buildSessionHistorySection(sessions: SessionSummary[]): string {
  const lines: string[] = ['## Recent Session History'];
  for (const session of sessions.slice(0, 3)) {
    const date = session.startedAt.toLocaleDateString();
    lines.push(`\n### Session (${date})`);
    if (session.summary) {
      lines.push(`Summary: ${session.summary}`);
    }
    if (session.nextSteps) {
      lines.push(`Next steps: ${session.nextSteps}`);
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
