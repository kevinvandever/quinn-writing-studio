import { Response } from 'express';
import { query } from '../db/connection.js';
import type Anthropic from '@anthropic-ai/sdk';
import {
  sendMessage,
  streamToSSE,
  assemblePrompt,
  determineModel,
  totalInputTokens,
  CACHE_1H,
  type ClaudeMessage,
  type ClaudeResponse,
  type StreamTools,
  type Effort,
  type ModelSelection,
  type ModelRoutingPreference,
  type ProjectContext,
  type SessionSummary,
  type TaskType,
} from './claude-api.service.js';
import { loadManuscriptContext } from './manuscript-context.service.js';
import {
  ARCHIVE_TOOLS,
  ARCHIVE_TOOLS_GUIDE,
  runArchiveTool,
  type ArchiveToolContext,
} from './archive-tools.service.js';
import {
  loadManuscriptChanges,
  buildRevisionHistoryContext,
  type ChangesBudget,
} from './revision-history.service.js';
import {
  loadNotebook,
  loadPieceIndex,
  renderNotebookForPrompt,
  renderNotebookForWriter,
  forgetNotebookEntries,
  updateNotebook,
  hasEndedSessions,
  openThreads,
  type Notebook,
} from './notebook.service.js';
import { formatWriterDate } from '../utils/time.js';
import { getEthicsPrompt, checkEthicsViolation, logEthicsBoundary } from './ethics.service.js';
import { logApiUsage } from './usage-tracking.service.js';
import { getRecentActivitySummary } from './activity.service.js';
import { ensureCorpusSummaries } from './corpus-summary.service.js';
import {
  setEarmark,
  loadEarmarkedPieces,
  detectFirstRightsConflicts,
  buildFirstRightsContext,
  loadPublishingOpportunities,
} from './submission-tracking.service.js';
import { buildTargetVenuesContext } from './target-venues.js';
import {
  getWorkflow,
  getPromptCommand,
  workflowsForProjectType,
  promptCommandsForProjectType,
  type CoachingWorkflow,
  type PromptCommand,
} from './coaching-workflows.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionContext {
  sessionId: string;
  projectId: string;
  sessionType: SessionType;
  project: ProjectContext;
  staleCorpus: boolean;
  inactivityDays: number | null;
  sessionSummaries: SessionSummary[];
  openingMessage: string | null;
}

export type SessionType = 'coaching' | 'editorial_review' | 'theme_analysis' | 'promptly_coaching';

interface SessionRow {
  id: string;
  project_id: string;
  session_type: SessionType;
  summary: string | null;
  next_steps: string | null;
  started_at: Date;
  ended_at: Date | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model_used: string | null;
  model_reason: string | null;
  token_count_input: number | null;
  token_count_output: number | null;
  created_at: Date;
}

// ─── Session Lifecycle ───────────────────────────────────────────────────────

/**
 * A sitting ends after this long without a message. The session is then
 * closed and summarized, so Session Memory reflects it. Before this existed, a
 * session only ended when the writer clicked End Session; otherwise it stayed
 * open for days, was never summarized, and Quinn never remembered it.
 */
export const SESSION_IDLE_HOURS = 4;

/** Thrown when a message is sent to a session that has already ended. */
export class SessionEndedError extends Error {
  constructor() {
    super('This session has ended.');
    this.name = 'SessionEndedError';
  }
}

export type CurrentSession =
  | { resumed: true; session: SessionRow; messages: MessageRow[] }
  | { resumed: false; session: SessionContext };

/**
 * Resume the project's open session if it's still active, otherwise start a
 * new one. An open session that has gone idle is closed first (summarized, or
 * deleted if the writer never spoke in it), so a new sitting always starts with
 * the previous one in Session Memory.
 */
export async function getOrStartCurrentSession(
  userId: string,
  projectId: string,
  sessionType: SessionType,
  options: { skipOpener?: boolean } = {}
): Promise<CurrentSession> {
  const openResult = await query<SessionRow & { last_activity: Date; user_messages: number }>(
    `SELECT s.id, s.project_id, s.session_type, s.summary, s.next_steps, s.started_at, s.ended_at,
            COALESCE(MAX(m.created_at), s.started_at) AS last_activity,
            (COUNT(m.id) FILTER (WHERE m.role = 'user'))::int AS user_messages
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.project_id = $1 AND s.ended_at IS NULL
     GROUP BY s.id
     ORDER BY s.started_at DESC
     LIMIT 1`,
    [projectId]
  );

  const latest = openResult.rows[0];
  if (latest) {
    const idleMs = Date.now() - new Date(latest.last_activity).getTime();
    if (idleMs < SESSION_IDLE_HOURS * 60 * 60 * 1000) {
      const messages = await query<MessageRow>(
        `SELECT id, session_id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [latest.id]
      );
      const { last_activity: _lastActivity, user_messages: _userMessages, ...session } = latest;
      return { resumed: true, session, messages: messages.rows };
    }
    await closeSession(userId, latest.id, latest.user_messages);
  }

  const context = await startSession(userId, projectId, sessionType, options);
  return { resumed: false, session: context };
}

/**
 * Close every open session that has had no message for `idleHours`. Run hourly
 * by the job scheduler. Returns how many were ended and how many removed.
 */
export async function closeIdleSessions(
  idleHours = SESSION_IDLE_HOURS
): Promise<{ ended: number; removed: number }> {
  const idle = await query<{ id: string; user_id: string; user_messages: number }>(
    `SELECT s.id, p.user_id,
            (COUNT(m.id) FILTER (WHERE m.role = 'user'))::int AS user_messages
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.ended_at IS NULL
     GROUP BY s.id, p.user_id
     HAVING COALESCE(MAX(m.created_at), s.started_at) < NOW() - make_interval(hours => $1)
     ORDER BY s.started_at ASC`,
    [idleHours]
  );

  let ended = 0;
  let removed = 0;
  for (const row of idle.rows) {
    try {
      const outcome = await closeSession(row.user_id, row.id, row.user_messages);
      if (outcome === 'ended') ended++;
      if (outcome === 'removed') removed++;
    } catch (err) {
      // One failure (e.g. the API is down for the summary) shouldn't block the rest;
      // the session stays open and the next run tries again.
      console.warn(
        `[Sessions] Failed to close idle session ${row.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { ended, removed };
}

/**
 * End a session with a summary, or delete it if the writer never sent a
 * message (only Quinn's greeting, or nothing). An empty session would
 * otherwise take a Session Memory slot and reset the "days since your last
 * session" count without the writer having done anything.
 */
async function closeSession(
  userId: string,
  sessionId: string,
  userMessages: number
): Promise<'ended' | 'removed'> {
  if (userMessages === 0) {
    await query(`DELETE FROM sessions WHERE id = $1 AND ended_at IS NULL`, [sessionId]);
    return 'removed';
  }
  await endSession(userId, sessionId);
  return 'ended';
}

// ─── Start Session ───────────────────────────────────────────────────────────

/**
 * Start a new coaching session for a project.
 * Creates the session in DB, loads project context, checks stale corpus and inactivity gap.
 *
 * `skipOpener` suppresses Quinn's greeting, for when the writer already has a
 * message on the way (the previous session closed while the page was open).
 */
export async function startSession(
  userId: string,
  projectId: string,
  sessionType: SessionType,
  options: { skipOpener?: boolean } = {}
): Promise<SessionContext> {
  // Verify project ownership
  const projectResult = await query<{
    id: string;
    name: string;
    central_question: string | null;
    description: string | null;
  }>(
    `SELECT id, name, central_question, description
     FROM projects
     WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
    [projectId, userId]
  );

  const project = projectResult.rows[0];
  if (!project) {
    throw new Error('Project not found');
  }

  // Create session in DB
  const sessionResult = await query<SessionRow>(
    `INSERT INTO sessions (project_id, session_type, started_at)
     VALUES ($1, $2, NOW())
     RETURNING id, project_id, session_type, summary, next_steps, started_at, ended_at`,
    [projectId, sessionType]
  );

  const session = sessionResult.rows[0];
  if (!session) {
    throw new Error('Failed to create session');
  }

  // Check stale corpus
  const staleCorpus = await checkStaleCorpus(projectId, userId);

  // Check inactivity gap
  const inactivityDays = await checkInactivityGap(projectId);

  // Load recent session summaries
  const sessionSummaries = await loadSessionSummaries(projectId);

  // Log activity event
  await query(
    `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
     VALUES ($1, $2, 'session_start', $3)`,
    [userId, projectId, JSON.stringify({ session_id: session.id, session_type: sessionType })]
  );

  // Backfill per-document summaries in the background so collection-level
  // coaching has substance for every piece. Fire-and-forget — never blocks
  // the session, and no-ops when summaries are already current.
  void ensureCorpusSummaries(projectId, userId);

  // Generate a proactive opening message from Quinn (coaching sessions only).
  // She greets the writer with what she noticed changed and where they left off.
  let openingMessage: string | null = null;
  if (sessionType === 'coaching' && !options.skipOpener) {
    openingMessage = await generateSessionOpener(
      userId,
      session.id,
      projectId,
      {
        name: project.name,
        centralQuestion: project.central_question,
        description: project.description,
      },
      sessionSummaries,
      inactivityDays
    );
  }

  return {
    sessionId: session.id,
    projectId,
    sessionType,
    project: {
      name: project.name,
      centralQuestion: project.central_question,
      description: project.description,
    },
    staleCorpus,
    inactivityDays,
    sessionSummaries,
    openingMessage,
  };
}

/**
 * Generate a proactive opening message from Quinn when a coaching session
 * starts. She references what changed in the manuscript since last time and
 * where the previous session left off, then invites the writer in.
 *
 * Returns null (no opener) for a brand-new project with no history or changes,
 * so Quinn doesn't fabricate a greeting out of nothing.
 */
async function generateSessionOpener(
  userId: string,
  sessionId: string,
  projectId: string,
  project: ProjectContext,
  sessionSummaries: SessionSummary[],
  inactivityDays: number | null
): Promise<string | null> {
  const corpusChanges = await loadManuscriptChanges(projectId, OPENER_CHANGES_BUDGET);
  const hasHistory = sessionSummaries.length > 0;

  // Nothing to open with — let the writer start.
  if (!corpusChanges && !hasHistory) {
    return null;
  }

  const personaConfig = await loadPersonaConfig(userId);

  // Build a focused prompt for the opener
  const contextParts: string[] = [];
  if (corpusChanges) {
    contextParts.push(corpusChanges);
  }
  if (hasHistory) {
    const last = sessionSummaries[0]!;
    if (last.summary) contextParts.push(`Last session: ${last.summary}`);
    if (last.nextSteps) contextParts.push(`What was next: ${last.nextSteps}`);
  }
  const threads = openThreads(await loadNotebook(projectId));
  if (threads.length > 0) {
    contextParts.push(`Open threads in your notebook:\n${threads.map((t) => `- ${t}`).join('\n')}`);
  }
  if (inactivityDays !== null && inactivityDays > 0) {
    contextParts.push(`It has been ${inactivityDays} day${inactivityDays > 1 ? 's' : ''} since the last session.`);
  }

  const openerSystemPrompt = `${buildOpenerPersonaIntro(personaConfig)}

You are starting a new coaching session with the writer on their project "${project.name}". Before they say anything, you greet them — warmly, briefly, in your voice.

Use what you know (below) to open the conversation: acknowledge what changed in their manuscript since last time, reference where you left off, and ask ONE inviting question about where they'd like to begin. Keep it to 2-4 sentences. Do not list everything mechanically — pick what's most interesting to ask about. Do not use a sign-off or farewell. This is a greeting, not a closing.

What you know:
${contextParts.join('\n\n')}`;

  try {
    const response = await sendMessage({
      systemPrompt: openerSystemPrompt,
      messages: [
        {
          role: 'user',
          content: 'Begin the session by greeting me with what you noticed.',
        },
      ],
      model: 'sonnet' as ModelSelection,
      effort: 'low',
      maxTokens: 2000,
    });

    const opener = response.content.trim();
    if (!opener) return null;

    // Persist the opener as Quinn's first message in the session
    await query(
      `INSERT INTO messages (session_id, role, content, model_used, model_reason, token_count_input, token_count_output)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
      [
        sessionId,
        opener,
        response.model,
        'Session opener',
        response.inputTokens,
        response.outputTokens,
      ]
    );

    await logApiUsage(userId, response.model, 'coaching', response.inputTokens, response.outputTokens);

    return opener;
  } catch (err) {
    // If opener generation fails, just start without one — not worth blocking the session
    console.warn('[Coaching] Failed to generate session opener:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Build a compact persona intro for the opener prompt — name, role, voice.
 */
function buildOpenerPersonaIntro(personaConfig: Record<string, unknown>): string {
  const name = (personaConfig['name'] as string) || 'Quinn';
  const identity = personaConfig['identity'] as Record<string, unknown> | undefined;
  const voice = personaConfig['voice'] as Record<string, unknown> | undefined;
  const role = identity?.['role'] as string | undefined;
  const tone = voice?.['tone'] as string | undefined;

  const parts = [`You are ${name}${role ? `, ${role}` : ''}.`];
  if (tone) parts.push(`Your voice: ${tone}.`);
  return parts.join(' ');
}

// ─── Send Message ────────────────────────────────────────────────────────────

/**
 * Send a user message in a coaching session, stream the response via SSE.
 * Persists both user message and assistant response to the messages table.
 */
export async function sendSessionMessage(
  userId: string,
  sessionId: string,
  content: string,
  res: Response
): Promise<void> {
  // Load session
  const sessionResult = await query<SessionRow>(
    `SELECT id, project_id, session_type, summary, next_steps, started_at, ended_at
     FROM sessions
     WHERE id = $1`,
    [sessionId]
  );

  const session = sessionResult.rows[0];
  if (!session) {
    throw new Error('Session not found');
  }

  if (session.ended_at) {
    throw new SessionEndedError();
  }

  // Verify project ownership
  const projectResult = await query<{
    id: string;
    user_id: string;
    name: string;
    central_question: string | null;
    description: string | null;
    project_type: string | null;
  }>(
    `SELECT id, user_id, name, central_question, description, project_type
     FROM projects
     WHERE id = $1 AND user_id = $2`,
    [session.project_id, userId]
  );

  const project = projectResult.rows[0];
  if (!project) {
    throw new Error('Project not found or access denied');
  }

  // Persist user message
  await query(
    `INSERT INTO messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [sessionId, content]
  );

  // ── Workflow commands ──────────────────────────────────────────────────
  // Leading-slash messages drive the workflow engine (/help, /<workflow>,
  // /next, /back, /exit). Some are answered statically; start/next/back update
  // state and fall through to an LLM turn with a clean directive.
  const priorWorkflowState = await loadWorkflowState(sessionId);
  let workflowState: WorkflowState | null = priorWorkflowState;
  let claudeDirective: string | null = null;
  let commandContext: string | null = null;
  let commandForcedTitle: string | null = null;
  let commandPreferOpus = false;
  let commandReadsWholeCorpus = false;

  if (content.trim().startsWith('/')) {
    const outcome = await handleSlashCommand(
      res,
      sessionId,
      session.project_id,
      userId,
      project.project_type,
      priorWorkflowState,
      content
    );
    if (outcome.handledStatically) {
      return; // static reply already streamed
    }
    workflowState = outcome.workflowState;
    claudeDirective = outcome.claudeDirective;
    commandContext = outcome.commandContext;
    commandForcedTitle = outcome.forcedTitle;
    commandPreferOpus = outcome.preferOpus;
    commandReadsWholeCorpus = !!outcome.readsWholeCorpus;
  }

  // Load conversation history for this session
  const messagesResult = await query<MessageRow>(
    `SELECT id, session_id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const allMessages = messagesResult.rows
    .filter((m) => m.role === 'user' || m.role === 'assistant');

  const turn = await buildTurnRequest({
    userId,
    projectId: session.project_id,
    project,
    sessionId,
    sessionType: session.session_type,
    sessionStartedAt: session.started_at,
    history: allMessages,
    content,
    claudeDirective,
    workflowState,
    command: {
      context: commandContext,
      forcedTitle: commandForcedTitle,
      preferOpus: commandPreferOpus,
      readsWholeCorpus: commandReadsWholeCorpus,
    },
  });

  // Stream response via SSE
  const { promise } = streamToSSE(res, {
    systemPrompt: turn.system,
    messages: turn.messages,
    model: turn.model,
    modelReason: turn.modelReason,
    effort: turn.effort,
    tools: turn.tools,
  });

  // Wait for stream to complete
  const claudeResponse: ClaudeResponse = await promise;

  // No text came back (the writer already saw an error). The tokens were still
  // billed, so log them, but don't store an empty reply: it would break the
  // next request, since the API rejects empty message content.
  if (!claudeResponse.content.trim()) {
    await logApiUsage(
      userId,
      claudeResponse.model,
      turn.taskType,
      claudeResponse.inputTokens,
      claudeResponse.outputTokens,
      claudeResponse.cache
    );
    return;
  }

  // Persist assistant message
  await query(
    `INSERT INTO messages (session_id, role, content, model_used, model_reason, token_count_input, token_count_output)
     VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
    [
      sessionId,
      claudeResponse.content,
      claudeResponse.model,
      turn.modelReason,
      totalInputTokens(claudeResponse),
      claudeResponse.outputTokens,
    ]
  );

  // Log API usage
  await logApiUsage(
    userId,
    claudeResponse.model,
    turn.taskType,
    claudeResponse.inputTokens,
    claudeResponse.outputTokens,
    claudeResponse.cache
  );

  // Check ethics violations
  if (checkEthicsViolation(claudeResponse.content)) {
    await logEthicsBoundary(userId, sessionId, content, claudeResponse.content);
  }
}

/** Everything needed to build one coaching request. */
export interface TurnRequestInput {
  userId: string;
  projectId: string;
  project: { name: string; central_question: string | null; description: string | null };
  sessionId: string;
  sessionType: SessionType;
  sessionStartedAt: Date;
  /** The session's messages so far, oldest first, including the writer's new one. */
  history: Array<Pick<MessageRow, 'role' | 'content' | 'model_used' | 'created_at'>>;
  /** The writer's new message, as typed (used to find pieces named in it). */
  content: string;
  /** Replaces the writer's message for workflow commands (/next etc.). */
  claudeDirective: string | null;
  workflowState: WorkflowState | null;
  command: {
    context: string | null;
    forcedTitle: string | null;
    preferOpus: boolean;
    readsWholeCorpus: boolean;
  };
  /** Treat Quinn as having greeted the writer already, so no welcome-back cues (quality checks). */
  assumeGreeted?: boolean;
}

/** A coaching request, ready to send. */
export interface TurnRequest {
  system: Anthropic.Messages.TextBlockParam[];
  messages: Anthropic.Messages.MessageParam[];
  model: ModelSelection;
  modelReason: string;
  effort: Effort;
  taskType: TaskType;
  tools: StreamTools;
}

/**
 * Build the request for one coaching turn: Quinn's prompt (persona, the
 * manuscript, map, notebook, Session Memory, and this turn's context), the
 * conversation, model routing, and her tools. Reads only; it writes nothing.
 */
export async function buildTurnRequest(input: TurnRequestInput): Promise<TurnRequest> {
  const { userId, projectId, project, sessionId, sessionType, sessionStartedAt, content } = input;
  const { claudeDirective, workflowState } = input;
  const commandContext = input.command.context;
  const commandForcedTitle = input.command.forcedTitle;
  const commandPreferOpus = input.command.preferOpus;
  const commandReadsWholeCorpus = input.command.readsWholeCorpus;
  const allMessages = input.history;

  // Build the conversation as role/content pairs.
  const convoPairs: ClaudeMessage[] = allMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // For command-driven workflow turns (/start, /next, /back), swap the raw
  // slash command the writer typed for a clean directive, so Claude isn't fed
  // "/next" as the user's turn.
  if (claudeDirective) {
    if (convoPairs.length > 0 && convoPairs[convoPairs.length - 1]!.role === 'user') {
      convoPairs.pop();
    }
    convoPairs.push({ role: 'user', content: claudeDirective });
  }

  // Send as much of this session as fits a character budget. A sitting usually
  // fits whole. When it doesn't, the prompt says plainly that earlier messages
  // are missing, so Quinn asks instead of pretending to remember. (This
  // replaces a 20-message window that told her she had the dropped messages
  // "in memory", which she didn't.)
  // Old messages are dropped in chunks that end at fixed points in the
  // session (every HISTORY_TRIM_CHARS of conversation), so the window's first
  // message stays the same for many turns. Sliding it one message per turn
  // would change the start of the history every turn, and the whole cached
  // history would be rewritten to the prompt cache (at 2x input price) each
  // time. The kept window ranges from about 80k to 120k characters.
  const HISTORY_CHAR_BUDGET = 120_000; // roughly 40k tokens
  const HISTORY_TRIM_CHARS = 40_000;
  const MIN_RECENT_MESSAGES = 6; // always keep the latest exchanges, even if long
  const charsBefore: number[] = [0]; // charsBefore[i]: characters in messages 0..i-1
  for (const m of convoPairs) charsBefore.push(charsBefore[charsBefore.length - 1]! + m.content.length);
  const totalChars = charsBefore[convoPairs.length]!;
  const latestStart = Math.max(0, convoPairs.length - MIN_RECENT_MESSAGES);
  let historyStart = 0;
  while (totalChars - charsBefore[historyStart]! > HISTORY_CHAR_BUDGET && historyStart < latestStart) {
    // Move to the first message at or past the next chunk boundary.
    const boundary =
      (Math.floor(charsBefore[historyStart]! / HISTORY_TRIM_CHARS) + 1) * HISTORY_TRIM_CHARS;
    let next = historyStart + 1;
    while (next < latestStart && charsBefore[next]! < boundary) next++;
    historyStart = next;
  }
  let conversationMessages: ClaudeMessage[] = convoPairs.slice(historyStart);
  const omittedCount = historyStart;
  const conversationNote =
    omittedCount > 0
      ? `This session is long, so its first ${omittedCount} message${omittedCount === 1 ? '' : 's'} aren't included below. You don't have their text, so don't claim to remember them. If the writer refers to something from earlier in the session that you can't see, look for it with search_conversations, or ask them to remind you.`
      : null;
  // Conversation search skips what this request already shows: this session
  // from the first message in the window on.
  const visibleSince = allMessages[historyStart]?.created_at ?? sessionStartedAt;

  // The API requires the conversation to begin with a user turn, but a session
  // usually opens with Quinn's greeting, and the writer's first message is often
  // a reply to it. Keep the greeting behind a short placeholder turn instead of
  // dropping it, so Quinn knows what she asked.
  if (conversationMessages[0]?.role === 'assistant') {
    conversationMessages = [
      {
        role: 'user',
        content:
          omittedCount > 0
            ? '(Earlier messages in this session are omitted.)'
            : '(The writer opened a coaching session.)',
      },
      ...conversationMessages,
    ];
  }

  // Load persona config
  const personaConfig = await loadPersonaConfig(userId);

  // Load settings for model routing preference
  const modelPreference = await loadModelRoutingPreference(userId);

  // Load session summaries for context
  const sessionSummaries = await loadSessionSummaries(projectId);

  // Quinn's notebook: her long-term notes on this project (decisions, notes on
  // pieces, patterns, open threads), revised after each session ends.
  const notebook = await loadNotebook(projectId);
  const notebookContext = renderNotebookForPrompt(notebook, await pieceIndexFor(notebook, projectId));

  // The whole manuscript goes into the cached part of the prompt, so Quinn has
  // read every piece in full on every turn. Whole-corpus modes (/analyze, essay
  // triage) also get everything outside the book (salvage, notes, research).
  const activeWorkflow = workflowState ? getWorkflow(workflowState.workflowId) : undefined;
  const readsWholeCorpus = commandReadsWholeCorpus || !!activeWorkflow?.readsWholeCorpus;
  const manuscript = await loadManuscriptContext(projectId, {
    includeOutside: readsWholeCorpus,
  });
  const inCachedPrompt = new Set([...manuscript.bookIds, ...manuscript.outsideIds]);

  // Projects without a Scrivener manuscript (Substack, Promptly) get opening
  // excerpts of their documents instead, also in the cached part.
  const corpusOverview = manuscript.bookText
    ? { entries: [], ids: new Set<string>() }
    : await loadCorpusOverview(projectId);

  // Per-turn retrieval for this message: the full text of pieces the writer
  // named (or a workflow targets) that aren't already in the prompt. Anything
  // else, Quinn looks up herself with the archive tools.
  const forcedTitles = [workflowState?.targetPieceTitle, commandForcedTitle].filter(
    (t): t is string => !!t
  );
  const corpusContext = await loadCorpusContext(
    projectId,
    content,
    forcedTitles,
    inCachedPrompt
  );

  // Load the full manuscript map (Scrivener binder structure) so Quinn always
  // knows what exists and where, with a logline for every piece.
  const manuscriptMap = await loadManuscriptMap(projectId);

  // Check inactivity for context
  const inactivityDays = await checkInactivityGap(projectId);

  // Load stale threshold for welcome-back detection
  const userSettings = await query<{ stale_corpus_threshold_days: number | null }>(
    `SELECT stale_corpus_threshold_days FROM settings WHERE user_id = $1`,
    [userId]
  );
  const staleThreshold = userSettings.rows[0]?.stale_corpus_threshold_days ?? 7;

  // Greeting-type instructions (welcome back, "you noticed their changes")
  // belong only before Quinn's first reply in a session. Previously they were
  // sent on every turn, so she could welcome the writer back again and again.
  // The opener counts as a reply; static command replies (no model) don't.
  const quinnHasReplied =
    !!input.assumeGreeted ||
    allMessages.some((m) => m.role === 'assistant' && m.model_used !== null);

  // Build activity context with welcome-back note if inactivity exceeds threshold
  let activityContext: string | null = null;
  if (!quinnHasReplied) {
    if (inactivityDays !== null && inactivityDays > staleThreshold) {
      activityContext = `WELCOME BACK: It has been ${inactivityDays} days since the last coaching session for this project. The writer has been away for a while. Acknowledge their return warmly, ask what brought them back, and gently reconnect them with where they left off. Reference the previous session summaries to help them pick up the thread.`;
    } else if (inactivityDays !== null && inactivityDays > 0) {
      activityContext = `It has been ${inactivityDays} day${inactivityDays > 1 ? 's' : ''} since the last coaching session for this project.`;
    }
  }

  // Load recent activity summary and append to activity context
  const recentActivity = await getRecentActivitySummary(userId, projectId);
  if (recentActivity) {
    activityContext = activityContext
      ? `${activityContext}\n\n${recentActivity}`
      : recentActivity;
  }

  // What changed in the manuscript since the last session, down to the
  // passages cut, added, and rewritten. It stays the same through the sitting,
  // so it's cached with the map; only the cue to acknowledge it is per turn,
  // and only before Quinn's first reply.
  const manuscriptChanges = await loadManuscriptChanges(projectId, CHANGES_BUDGET);
  if (manuscriptChanges && !quinnHasReplied) {
    const cue =
      'The writer has changed the manuscript (see the Manuscript Changes section). Acknowledge their work naturally, and be specific about what you noticed.';
    activityContext = activityContext ? `${activityContext}\n\n${cue}` : cue;
  }

  // Determine task type for model routing
  const taskType: TaskType = sessionType === 'editorial_review'
    ? 'editorial'
    : sessionType === 'theme_analysis'
      ? 'theme_analysis'
      : sessionType === 'promptly_coaching'
        ? 'promptly_coaching'
        : 'coaching';

  // Load Promptly-specific context if applicable
  let promptlyContext: string | null = null;
  let historicalPostCount = 0;
  if (sessionType === 'promptly_coaching') {
    const promptlyData = await loadPromptlyContext(sessionId, projectId);
    promptlyContext = promptlyData.context;
    historicalPostCount = promptlyData.historicalPostCount;
  }

  // Determine model
  const routingDecision = determineModel(
    taskType,
    {
      corpusDocCount: corpusContext.length,
      historicalPostCount,
      taskType,
    },
    modelPreference
  );

  // Heavy workflows and deep modes prefer Opus for fuller analysis — but only
  // when routing is on auto (an explicit always_sonnet preference still wins).
  const workflowPrefersOpus = commandPreferOpus || !!activeWorkflow?.preferOpus;
  if (workflowPrefersOpus && modelPreference === 'auto' && routingDecision.model !== 'opus') {
    routingDecision.model = 'opus';
    routingDecision.reason = 'Deep coaching mode — using Opus for fuller analysis';
  }

  // Effort follows the task, not the model: workflows and deep modes get
  // high, everyday conversation gets medium (Anthropic's recommended start for
  // chat). This also controls how much the model thinks before answering.
  const effort: Effort =
    workflowPrefersOpus || taskType === 'theme_analysis' ? 'high' : 'medium';

  // First-publication rights: pieces reserved for journal submission, plus any
  // apparent Substack collisions. Null when nothing is earmarked.
  let firstRightsContext: string | null = null;
  try {
    const earmarkedPieces = await loadEarmarkedPieces(projectId);
    if (earmarkedPieces.length > 0) {
      const conflicts = await detectFirstRightsConflicts(userId, projectId);
      firstRightsContext = buildFirstRightsContext(earmarkedPieces, conflicts);
    }
  } catch (err) {
    console.warn(
      '[Coaching] First-rights check failed:',
      err instanceof Error ? err.message : err
    );
  }

  // Build the active-workflow section (if a workflow is running).
  const workflowContext =
    activeWorkflow && workflowState ? buildWorkflowContext(activeWorkflow, workflowState) : null;

  // Assemble the prompt: two cached system blocks (the stable bulk, then the
  // per-session part), plus per-turn context that rides with the writer's message.
  const { system, turnContext } = assemblePrompt({
    personaConfig,
    projectContext: {
      name: project.name,
      centralQuestion: project.central_question,
      description: project.description,
    },
    taskInstructions: getTaskInstructions(taskType),
    ethicsPrompt: getEthicsPrompt(),
    toolsGuide: ARCHIVE_TOOLS_GUIDE,
    manuscriptText: manuscript.bookText,
    outsideText: manuscript.outsideText,
    corpusOverview: corpusOverview.entries,
    manuscriptMap,
    firstRightsContext,
    manuscriptChanges,
    notebook: notebookContext,
    sessionHistories: sessionSummaries,
    sessionContext: promptlyContext || null,
    activityContext,
    conversationNote,
    workflowContext,
    commandContext,
    retrievedContext: corpusContext,
  });

  // Quinn can look up what isn't in the prompt: the writer's other writing,
  // past conversations, and earlier versions of pieces. The same tools go with
  // every coaching request, since they're part of the cached prefix.
  const toolContext: ArchiveToolContext = {
    userId,
    projectId,
    sessionId,
    inPrompt: inCachedPrompt,
    visibleSince,
  };

  return {
    system,
    messages: buildApiMessages(conversationMessages, turnContext),
    model: routingDecision.model,
    modelReason: routingDecision.reason,
    effort,
    taskType,
    tools: {
      definitions: ARCHIVE_TOOLS,
      run: (call, announce) => runArchiveTool(toolContext, call, announce),
    },
  };
}

/**
 * Turn the conversation into API messages for a cached request:
 * - a one-hour cache breakpoint on Quinn's last reply, so next turn the
 *   history up to here is read from cache instead of reprocessed;
 * - this turn's context attached to the writer's newest message. It sits after
 *   every breakpoint, so it can change each turn without breaking the cache,
 *   and it's framed so Quinn doesn't take it for the writer's own words.
 */
function buildApiMessages(
  conversation: ClaudeMessage[],
  turnContext: string
): Anthropic.Messages.MessageParam[] {
  const messages: Anthropic.Messages.MessageParam[] = conversation.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let i = conversation.length - 2; i >= 0; i--) {
    const message = conversation[i]!;
    if (message.role === 'assistant' && message.content.trim()) {
      messages[i] = {
        role: 'assistant',
        content: [{ type: 'text', text: message.content, cache_control: CACHE_1H }],
      };
      break;
    }
  }

  const contextBlock: Anthropic.Messages.TextBlockParam = {
    type: 'text',
    text: `<turn_context>\nContext from the Quinn app for this turn only. The writer didn't type this; use it, but don't mention it or reply to it.\n\n${turnContext}\n</turn_context>`,
  };
  const last = conversation[conversation.length - 1];
  if (last && last.role === 'user') {
    messages[messages.length - 1] = {
      role: 'user',
      content: [contextBlock, { type: 'text', text: last.content }],
    };
  } else {
    messages.push({ role: 'user', content: [contextBlock] });
  }
  return messages;
}

// ─── End Session ─────────────────────────────────────────────────────────────

/**
 * End a coaching session. Generates a summary via Claude (non-streaming),
 * stores summary and next_steps, marks ended_at.
 */
export async function endSession(
  userId: string,
  sessionId: string
): Promise<{ summary: string; nextSteps: string }> {
  // Load session
  const sessionResult = await query<SessionRow>(
    `SELECT id, project_id, session_type, summary, next_steps, started_at, ended_at
     FROM sessions
     WHERE id = $1`,
    [sessionId]
  );

  const session = sessionResult.rows[0];
  if (!session) {
    throw new Error('Session not found');
  }

  // Verify project ownership
  const projectResult = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM projects WHERE id = $1 AND user_id = $2`,
    [session.project_id, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found or access denied');
  }

  // Already ended (by the idle closer, or another tab): return what was saved
  // rather than failing, so End Session is safe to click at any time.
  if (session.ended_at) {
    return { summary: session.summary ?? '', nextSteps: session.next_steps ?? '' };
  }

  // Load all messages for this session
  const messagesResult = await query<MessageRow>(
    `SELECT id, session_id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const transcript = messagesResult.rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Quinn'}: ${m.content}`)
    .join('\n\n');

  // Generate summary via Claude (non-streaming)
  // Generate summary via Claude (non-streaming). If this fails (e.g. Anthropic
  // overloaded), we still end the session with a fallback so the action never
  // silently breaks.
  let summary = '';
  let nextSteps = '';
  let summaryModel: ModelSelection | null = null;
  let summaryInputTokens = 0;
  let summaryOutputTokens = 0;

  try {
    const summaryResponse = await sendMessage({
      systemPrompt: `You are Quinn's memory. Given a coaching session transcript, produce two things:

1. A rich summary (3-5 sentences) that captures: what was discussed, any emotional undertones or breakthroughs, specific essays or pieces referenced by name, decisions made, fears or doubts surfaced, and any creative insights that emerged. Write as if you are recording memories you'll need to recall next time you see this writer — not a corporate meeting summary.

2. Concrete next steps or open threads that should be picked up next session.

Format your response as JSON: {"summary": "...", "next_steps": "..."}`,
      messages: [
        {
          role: 'user',
          content: `Please summarize this coaching session:\n\n${transcript}`,
        },
      ],
      model: 'sonnet' as ModelSelection,
      // This is Quinn's only long-term memory of the session; worth some thought.
      effort: 'medium',
    });

    summaryModel = summaryResponse.model;
    summaryInputTokens = summaryResponse.inputTokens;
    summaryOutputTokens = summaryResponse.outputTokens;

    if (!summaryResponse.content.trim()) {
      throw new Error('Summary response contained no text');
    }

    try {
      const parsed = JSON.parse(extractJSON(summaryResponse.content));
      summary = parsed.summary || '';
      nextSteps = parsed.next_steps || '';
    } catch {
      // If JSON parsing fails, use the raw content as summary
      summary = summaryResponse.content;
      nextSteps = '';
    }
  } catch (err) {
    // Claude call failed — end the session anyway with a minimal fallback summary
    console.warn('[Coaching] Summary generation failed, ending session with fallback:', err instanceof Error ? err.message : err);
    const messageCount = messagesResult.rows.filter((m) => m.role === 'user' || m.role === 'assistant').length;
    summary = `Session on ${formatWriterDate(new Date())} with ${messageCount} messages exchanged. (Summary could not be generated automatically.)`;
    nextSteps = '';
  }

  // Update session with summary and end time
  await query(
    `UPDATE sessions
     SET summary = $1, next_steps = $2, ended_at = NOW()
     WHERE id = $3`,
    [summary, nextSteps, sessionId]
  );

  // Log API usage for summary generation (only if the call succeeded)
  if (summaryModel) {
    await logApiUsage(
      userId,
      summaryModel,
      'coaching',
      summaryInputTokens,
      summaryOutputTokens
    );
  }

  // Log activity event
  await query(
    `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
     VALUES ($1, $2, 'session_end', $3)`,
    [userId, session.project_id, JSON.stringify({ session_id: sessionId })]
  );

  // Fold this session into Quinn's notebook in the background. If it fails,
  // the hourly session closer retries.
  void updateNotebook(session.project_id, userId);

  return { summary, nextSteps };
}

/** Room for changed passages in "Manuscript Changes Since Your Last Session". */
const CHANGES_BUDGET: ChangesBudget = { total: 16_000, perPiece: 4_000 };
/** The opener is a short greeting; it needs only the gist. */
const OPENER_CHANGES_BUDGET: ChangesBudget = { total: 6_000, perPiece: 1_500 };

/** The piece index, loaded only when the notebook has notes on pieces to place. */
async function pieceIndexFor(notebook: Notebook | null, projectId: string) {
  return notebook?.entries.some((e) => e.kind === 'piece') ? loadPieceIndex(projectId) : null;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Check if the corpus is stale (last import older than threshold).
 */
async function checkStaleCorpus(projectId: string, userId: string): Promise<boolean> {
  // Load stale threshold from settings
  const settingsResult = await query<{ stale_corpus_threshold_days: number | null }>(
    `SELECT stale_corpus_threshold_days FROM settings WHERE user_id = $1`,
    [userId]
  );

  const thresholdDays = settingsResult.rows[0]?.stale_corpus_threshold_days ?? 7;

  // Check last import date
  const importResult = await query<{ imported_at: Date }>(
    `SELECT imported_at FROM scrivener_imports
     WHERE project_id = $1
     ORDER BY imported_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (importResult.rows.length === 0) {
    return false; // No imports yet, not stale
  }

  const row = importResult.rows[0];
  if (!row) {
    return false;
  }

  const daysSinceImport = Math.floor(
    (Date.now() - row.imported_at.getTime()) / (1000 * 60 * 60 * 24)
  );

  return daysSinceImport > thresholdDays;
}

/**
 * Check how many days since the last session for this project.
 */
async function checkInactivityGap(projectId: string): Promise<number | null> {
  const result = await query<{ started_at: Date }>(
    `SELECT started_at FROM sessions
     WHERE project_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (result.rows.length === 0) {
    return null; // No previous sessions
  }

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const daysSince = Math.floor(
    (Date.now() - row.started_at.getTime()) / (1000 * 60 * 60 * 24)
  );

  return daysSince;
}

/**
 * Load summaries of the most recent ended sessions for a project.
 * Sessions now close after each sitting, so this covers the last several
 * sittings rather than a few long-lived sessions.
 */
const SESSION_MEMORY_COUNT = 5;

async function loadSessionSummaries(projectId: string): Promise<SessionSummary[]> {
  const result = await query<{
    summary: string | null;
    next_steps: string | null;
    started_at: Date;
  }>(
    `SELECT summary, next_steps, started_at
     FROM sessions
     WHERE project_id = $1 AND ended_at IS NOT NULL
     ORDER BY started_at DESC
     LIMIT $2`,
    [projectId, SESSION_MEMORY_COUNT]
  );

  return result.rows.map((row) => ({
    summary: row.summary,
    nextSteps: row.next_steps,
    startedAt: row.started_at,
  }));
}

/**
 * Load persona configuration for the user.
 */
async function loadPersonaConfig(userId: string): Promise<Record<string, unknown>> {
  const result = await query<{ config: Record<string, unknown> }>(
    `SELECT config FROM persona_configurations
     WHERE user_id = $1 AND is_active = true
     LIMIT 1`,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    // Return default persona config
    return {
      name: 'Quinn',
      identity: { role: 'Writing Coach' },
      voice: { tone: 'Warm and encouraging with playful bite' },
      principles: ['Partnership over hierarchy'],
    };
  }

  return row.config;
}

/**
 * Load model routing preference from user settings.
 */
async function loadModelRoutingPreference(userId: string): Promise<ModelRoutingPreference> {
  const result = await query<{ model_routing_preference: string | null }>(
    `SELECT model_routing_preference FROM settings WHERE user_id = $1`,
    [userId]
  );

  const pref = result.rows[0]?.model_routing_preference;
  if (pref === 'always_sonnet' || pref === 'always_opus' || pref === 'auto') {
    return pref;
  }

  return 'auto';
}

// ─── Manuscript Map ────────────────────────────────────────────────────────

interface CorpusNode {
  id: string;
  title: string;
  wordCount: number;
  isFolder: boolean;
  scrivenerType: string | null;
  summary: string | null;
  /** Reserved for literary journal submission — must not be published on Substack. */
  earmarked: boolean;
  sortOrder: number;
  children: CorpusNode[];
}

/** Map a raw Scrivener binder type to a short, human role label. */
function folderRoleLabel(scrivenerType: string | null): string | null {
  switch (scrivenerType) {
    case 'DraftFolder':
      return 'DRAFT — live manuscript';
    case 'ResearchFolder':
      return 'RESEARCH';
    case 'TrashFolder':
      return 'TRASH — deleted, ignore unless asked';
    default:
      return null;
  }
}

/**
 * Load the writer's full Scrivener binder as a rendered outline.
 *
 * Unlike corpus *content* (which is excerpt-based and budget-limited), this is
 * a complete structural map — every folder and document, with word counts and
 * folder roles — so Quinn always knows what exists, where it lives, and which
 * folder is the live manuscript versus research or trash. Cheap to include
 * because it carries titles, counts, and loglines only, no document bodies.
 *
 * Trash is collapsed to a single line. Listing its contents used up the
 * character cap, which cut off every folder after it in the binder.
 *
 * Returns null if the project has no Scrivener documents yet.
 */
export async function loadManuscriptMap(projectId: string): Promise<string | null> {
  const result = await query<{
    id: string;
    title: string;
    word_count: number | null;
    parent_id: string | null;
    sort_order: number | null;
    is_folder: boolean;
    metadata: {
      scrivenerType?: string | null;
      summary?: string | null;
      submissionStatus?: string | null;
    } | null;
  }>(
    `SELECT id, title, word_count, parent_id, sort_order, is_folder, metadata
     FROM corpus_documents
     WHERE project_id = $1 AND source_type = 'scrivener'`,
    [projectId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  // Build the tree from flat rows.
  const nodeMap = new Map<string, CorpusNode>();
  const roots: CorpusNode[] = [];

  for (const row of result.rows) {
    nodeMap.set(row.id, {
      id: row.id,
      title: row.title || 'Untitled',
      wordCount: row.word_count ?? 0,
      isFolder: row.is_folder,
      scrivenerType: row.metadata?.scrivenerType ?? null,
      summary: row.metadata?.summary ?? null,
      earmarked: row.metadata?.submissionStatus === 'earmarked',
      sortOrder: row.sort_order ?? 0,
      children: [],
    });
  }

  for (const row of result.rows) {
    const node = nodeMap.get(row.id)!;
    if (row.parent_id && nodeMap.has(row.parent_id)) {
      nodeMap.get(row.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Fully deterministic (ties broken by title, then id): the map sits in the
  // cached prompt, so its text must not change between turns.
  const sortNodes = (nodes: CorpusNode[]): void => {
    nodes.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.title.localeCompare(b.title, 'en') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);

  const isTrash = (n: CorpusNode): boolean =>
    n.scrivenerType === 'TrashFolder' ||
    (n.isFolder && n.title.trim().toLowerCase() === 'trash');

  // Count the documents (non-folders) anywhere beneath a node, and their words.
  const countDocsUnder = (node: CorpusNode): number =>
    node.children.reduce(
      (sum, child) => sum + (child.isFolder ? 0 : 1) + countDocsUnder(child),
      0
    );
  const countWordsUnder = (node: CorpusNode): number =>
    node.children.reduce(
      (sum, child) => sum + (child.isFolder ? 0 : child.wordCount) + countWordsUnder(child),
      0
    );

  // Tally totals outside Trash so Quinn knows the true size of the binder (and
  // won't assume there's hidden material when the list is actually complete).
  let folderCount = 0;
  let docCount = 0;
  let totalWords = 0;
  let trashDocs = 0;
  let trashWords = 0;
  const tally = (nodes: CorpusNode[]): void => {
    for (const n of nodes) {
      if (isTrash(n)) {
        trashDocs += countDocsUnder(n);
        trashWords += countWordsUnder(n);
        continue;
      }
      if (n.isFolder) {
        folderCount++;
      } else {
        docCount++;
        totalWords += n.wordCount;
      }
      tally(n.children);
    }
  };
  tally(roots);

  // Render an indented outline.
  const trashNote =
    trashDocs > 0
      ? ` Trash holds ${trashDocs} more (${trashWords.toLocaleString()} words), not listed.`
      : '';
  const lines: string[] = [
    `Binder contains ${docCount} document${docCount === 1 ? '' : 's'} (${totalWords.toLocaleString()} words) in ${folderCount} folder${folderCount === 1 ? '' : 's'}, outside Trash.${trashNote} Every piece outside Trash appears below. If a piece is not listed here, it has not been synced into this project (so don't claim hidden material exists when it doesn't, and don't invent pieces).`,
    '',
  ];
  const MAX_CHARS = 40000; // soft cap so an enormous binder can't dominate the prompt
  let truncated = false;
  let renderedChars = 0;

  const render = (nodes: CorpusNode[], depth: number): void => {
    for (const node of nodes) {
      if (renderedChars > MAX_CHARS) {
        truncated = true;
        return;
      }
      const indent = '  '.repeat(depth);
      if (isTrash(node)) {
        const line = `${indent}${node.title}/ [${folderRoleLabel('TrashFolder')}] — ${countDocsUnder(node)} pieces, ${countWordsUnder(node).toLocaleString()} words (contents not listed)`;
        lines.push(line);
        renderedChars += line.length + 1;
        continue;
      }
      let line: string;
      if (node.isFolder) {
        const role = folderRoleLabel(node.scrivenerType);
        const roleTag = role ? ` [${role}]` : '';
        const pieces = countDocsUnder(node);
        line = `${indent}${node.title}/${roleTag} — ${pieces} piece${pieces === 1 ? '' : 's'}, ${node.wordCount.toLocaleString()} words`;
      } else {
        const earmarkTag = node.earmarked ? ' [RESERVED FOR JOURNAL SUBMISSION]' : '';
        line = `${indent}${node.title} — ${node.wordCount.toLocaleString()} words${earmarkTag}`;
      }
      lines.push(line);
      renderedChars += line.length + 1;
      // Render the logline (if indexed) so collection-level reasoning has
      // substance for every piece, not just those with full text loaded.
      if (!node.isFolder && node.summary) {
        const summaryLine = `${indent}  · ${node.summary}`;
        lines.push(summaryLine);
        renderedChars += summaryLine.length + 1;
      }
      if (node.children.length > 0) {
        render(node.children, depth + 1);
      }
    }
  };

  render(roots, 0);

  if (truncated) {
    lines.push('… (binder truncated — ask about a specific folder to see the rest)');
  }

  return lines.join('\n');
}

/**
 * Collect the ids of every document inside the Trash folder (the trash folder
 * itself and all descendants), so corpus retrieval can exclude deleted work.
 */
async function loadTrashDocumentIds(projectId: string): Promise<Set<string>> {
  const result = await query<{ id: string }>(
    `WITH RECURSIVE trash AS (
       SELECT id FROM corpus_documents
        WHERE project_id = $1 AND source_type = 'scrivener' AND is_folder = true
          AND (metadata->>'scrivenerType' = 'TrashFolder' OR lower(title) = 'trash')
       UNION ALL
       SELECT c.id FROM corpus_documents c
         JOIN trash t ON c.parent_id = t.id
     )
     SELECT id FROM trash`,
    [projectId]
  );
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Return non-folder document ids in true Scrivener binder order (depth-first
 * through the folder tree), excluding anything in Trash. Cheap — pulls only
 * structural columns, no document content.
 */
async function loadBinderLeafOrder(projectId: string, trashIds: Set<string>): Promise<string[]> {
  const result = await query<{
    id: string;
    parent_id: string | null;
    sort_order: number | null;
    is_folder: boolean;
  }>(
    `SELECT id, parent_id, sort_order, is_folder
     FROM corpus_documents
     WHERE project_id = $1 AND source_type = 'scrivener'`,
    [projectId]
  );

  interface OrderNode {
    id: string;
    sortOrder: number;
    isFolder: boolean;
    children: OrderNode[];
  }

  const map = new Map<string, OrderNode>();
  const roots: OrderNode[] = [];
  for (const r of result.rows) {
    map.set(r.id, { id: r.id, sortOrder: r.sort_order ?? 0, isFolder: r.is_folder, children: [] });
  }
  for (const r of result.rows) {
    const node = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) {
      map.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (nodes: OrderNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);

  const ordered: string[] = [];
  const dfs = (nodes: OrderNode[]): void => {
    for (const node of nodes) {
      if (trashIds.has(node.id)) continue; // skips the trash folder and its whole subtree
      if (!node.isFolder) ordered.push(node.id);
      if (node.children.length > 0) dfs(node.children);
    }
  };
  dfs(roots);
  return ordered;
}

/**
 * Find documents the writer named (by title) in their message — or any titles
 * a workflow explicitly forces into context — and return their FULL text.
 * Distinctive essay titles ("Fenway", "Batter Up") are matched as whole
 * phrases so a named piece is never reduced to a 3k-char excerpt when the
 * writer actually wants to work on it.
 */
async function loadNamedDocuments(
  projectId: string,
  userMessage: string | undefined,
  forcedTitles: string[],
  trashIds: Set<string>,
  excludeIds: Set<string>
): Promise<Array<{ id: string; title: string; content: string }>> {
  // Pull titles only (cheap) to decide what to match before fetching bodies.
  const titlesResult = await query<{ id: string; title: string }>(
    `SELECT id, title FROM corpus_documents
     WHERE project_id = $1 AND is_folder = false AND content != ''`,
    [projectId]
  );

  const haystack = (userMessage ?? '').toLowerCase();
  const forcedLower = forcedTitles.map((t) => t.toLowerCase().trim()).filter(Boolean);

  const matchedIds: string[] = [];
  for (const row of titlesResult.rows) {
    // Trash is never surfaced; pieces already in the cached prompt aren't repeated.
    if (trashIds.has(row.id) || excludeIds.has(row.id)) continue;
    const title = (row.title ?? '').trim();
    if (title.length < 4) continue; // too short to match safely
    const titleLower = title.toLowerCase();
    const namedInMessage = haystack.includes(titleLower);
    const forced = forcedLower.some(
      (f) => f === titleLower || titleLower.includes(f) || f.includes(titleLower)
    );
    if (namedInMessage || forced) {
      matchedIds.push(row.id);
    }
  }

  // Cap so a message that happens to brush several titles can't blow the budget.
  const ids = matchedIds.slice(0, 4);
  if (ids.length === 0) return [];

  const docsResult = await query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM corpus_documents
     WHERE id = ANY($1::uuid[]) AND content != ''`,
    [ids]
  );
  return docsResult.rows;
}

/**
 * Load per-turn corpus material for the writer's message: the FULL text of
 * documents the writer named by title (or a workflow or mode targets), so deep
 * work on a specific piece is exact.
 *
 * This used to add 3,000-character excerpts of every document matching words
 * in the message. Quinn now searches the archive herself with tools when she
 * needs to, which is more precise and doesn't add up to 60k characters of
 * uncached excerpts to every turn.
 *
 * Nothing is sent twice: `inPrompt` documents (the full manuscript, and in
 * whole-corpus modes everything outside it) are skipped. Trash is excluded.
 */
async function loadCorpusContext(
  projectId: string,
  userMessage: string | undefined,
  forcedTitles: string[],
  inPrompt: Set<string>
): Promise<string[]> {
  const seen = new Set<string>(inPrompt);
  const docs: Array<{ title: string; content: string; full?: boolean }> = [];
  const trashIds = await loadTrashDocumentIds(projectId);

  const named = await loadNamedDocuments(projectId, userMessage, forcedTitles, trashIds, inPrompt);
  const MAX_NAMED_CHARS = 24000; // ~4-5k words; covers a long essay in full
  for (const d of named) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const content =
      d.content.length > MAX_NAMED_CHARS
        ? d.content.slice(0, MAX_NAMED_CHARS) + '\n...[truncated]'
        : d.content;
    docs.push({ title: d.title, content, full: true });
  }

  return docs.map(formatCorpusEntry);
}

function formatCorpusEntry(doc: { title: string; content: string; full?: boolean }): string {
  if (doc.full) {
    return `### ${doc.title} (FULL TEXT)\n${doc.content}`;
  }
  const excerpt = doc.content.length > 3000 ? doc.content.slice(0, 3000) + '...' : doc.content;
  return `### ${doc.title}\n${excerpt}`;
}

/**
 * Opening excerpts of the project's documents, for projects without a
 * Scrivener manuscript (Substack, Promptly). Scrivener documents come in binder
 * order, others by recency. Deterministic, so it can sit in the cached prompt.
 */
async function loadCorpusOverview(
  projectId: string
): Promise<{ entries: string[]; ids: Set<string> }> {
  const BASELINE_LIMIT = 40;
  const trashIds = await loadTrashDocumentIds(projectId);
  const scrivenerLeafIds = await loadBinderLeafOrder(projectId, trashIds);
  const nonScrivener = await query<{ id: string }>(
    `SELECT id FROM corpus_documents
     WHERE project_id = $1 AND source_type != 'scrivener' AND is_folder = false AND content != ''
     ORDER BY updated_at DESC, id
     LIMIT $2`,
    [projectId, BASELINE_LIMIT]
  );
  const baselineIds = [...scrivenerLeafIds, ...nonScrivener.rows.map((r) => r.id)].slice(
    0,
    BASELINE_LIMIT
  );
  if (baselineIds.length === 0) return { entries: [], ids: new Set() };

  const baseline = await query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM corpus_documents
     WHERE id = ANY($1::uuid[]) AND content != ''`,
    [baselineIds]
  );
  const byId = new Map(baseline.rows.map((r) => [r.id, r]));
  const rows = baselineIds
    .map((id) => byId.get(id))
    .filter((row): row is { id: string; title: string; content: string } => !!row);
  return {
    entries: rows.map((row) => formatCorpusEntry({ title: row.title, content: row.content })),
    ids: new Set(rows.map((row) => row.id)),
  };
}

// ─── Workflow Engine ───────────────────────────────────────────────────────

/**
 * Active-workflow state is persisted migration-free as a system message in the
 * `messages` table, prefixed with this marker. The latest such marker wins.
 * System messages are excluded from the LLM conversation and hidden in the UI.
 */
const WORKFLOW_MARKER = '[[QUINN_WORKFLOW]]';

interface WorkflowState {
  workflowId: string;
  stepIndex: number;
  targetPieceTitle: string | null;
  startedAt: string;
}

/** Load the current workflow state for a session, or null if none is active. */
async function loadWorkflowState(sessionId: string): Promise<WorkflowState | null> {
  const result = await query<{ content: string }>(
    `SELECT content FROM messages
     WHERE session_id = $1 AND role = 'system' AND content LIKE $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId, WORKFLOW_MARKER + '%']
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content.slice(WORKFLOW_MARKER.length));
    if (parsed && typeof parsed.workflowId === 'string' && parsed.workflowId) {
      return {
        workflowId: parsed.workflowId,
        stepIndex: typeof parsed.stepIndex === 'number' ? parsed.stepIndex : 0,
        targetPieceTitle: typeof parsed.targetPieceTitle === 'string' ? parsed.targetPieceTitle : null,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
      };
    }
    return null; // an explicit "cleared" marker
  } catch {
    return null;
  }
}

/** Persist a new workflow state (or null to clear it) as a marker message. */
async function saveWorkflowState(sessionId: string, state: WorkflowState | null): Promise<void> {
  const payload = state ? JSON.stringify(state) : 'null';
  await query(
    `INSERT INTO messages (session_id, role, content) VALUES ($1, 'system', $2)`,
    [sessionId, WORKFLOW_MARKER + payload]
  );
}

/** Persist a synthetic assistant message (used for command replies). */
async function persistAssistantMessage(sessionId: string, content: string): Promise<void> {
  await query(
    `INSERT INTO messages (session_id, role, content, model_reason)
     VALUES ($1, 'assistant', $2, 'Workflow command')`,
    [sessionId, content]
  );
}

/** Stream a fixed message to the client over SSE (for command replies, no LLM). */
function streamStaticMessage(res: Response, text: string): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: token\ndata: ${JSON.stringify({ token: text })}\n\n`);
  res.write(`event: done\ndata: ${JSON.stringify({ inputTokens: 0, outputTokens: 0 })}\n\n`);
  res.end();
}

/** Build the /help menu listing workflows and modes available for this project. */
function buildHelpMenu(projectType: string | null, state: WorkflowState | null): string {
  const workflows = workflowsForProjectType(projectType);
  const prompts = promptCommandsForProjectType(projectType);
  const lines: string[] = ['Quinn — Coaching Commands', ''];

  if (workflows.length > 0) {
    lines.push('Structured workflows (step by step):');
    for (const w of workflows) {
      const piece = w.targetsSinglePiece ? ' [piece]' : '';
      lines.push(`  /${w.id}${piece}  —  ${w.label}: ${w.description}`);
    }
    lines.push('');
  }

  if (prompts.length > 0) {
    lines.push('Quick modes (one response):');
    for (const c of prompts) {
      const piece = c.targetsSinglePiece ? ' [piece]' : '';
      lines.push(`  /${c.id}${piece}  —  ${c.label}: ${c.description}`);
    }
    lines.push('');
  }

  lines.push('Submission rights:');
  lines.push('  /earmark [piece]    —  Reserve a piece for literary journal submission');
  lines.push('  /unearmark [piece]  —  Release a reserved piece');
  lines.push('  /earmarked          —  List reserved pieces and any Substack conflicts');
  lines.push('');
  lines.push("Quinn's notebook:");
  lines.push('  /notebook           —  See what I keep between sessions');
  lines.push('  /forget [number]    —  Remove a note from the notebook, e.g. /forget n3');
  lines.push('');
  lines.push('Inside a workflow:  /next (advance)  ·  /back (previous step)  ·  /exit (leave)');
  lines.push('');
  if (state) {
    const wf = getWorkflow(state.workflowId);
    if (wf) {
      const step = wf.steps[state.stepIndex];
      lines.push(
        `Currently running ${wf.label}, step ${state.stepIndex + 1} of ${wf.steps.length}${step ? ` — ${step.title}` : ''}.`
      );
    } else {
      lines.push('Currently: no workflow active.');
    }
  } else {
    lines.push('Currently: no workflow active.');
  }
  return lines.join('\n');
}

/** Build the system-prompt section describing the active workflow step. */
function buildWorkflowContext(wf: CoachingWorkflow, state: WorkflowState): string {
  const total = wf.steps.length;
  const idx = Math.max(0, Math.min(state.stepIndex, total - 1));
  const step = wf.steps[idx]!;
  const parts: string[] = [
    `## Active Workflow: ${wf.label} (step ${idx + 1} of ${total})`,
    `You are running a structured workflow with the writer. Do ONLY the current step below, then stop and let them respond. When the step feels complete, briefly note they can say /next to continue (or /exit to stop). Never race ahead to later steps. This structure guides you — it is not a script to read aloud; stay fully in your own coaching voice.`,
  ];
  if (state.targetPieceTitle) {
    parts.push(`Working piece: "${state.targetPieceTitle}" — its full text is in The Manuscript section, or in the retrieved material if it lives outside the book.`);
  }
  parts.push(`CURRENT STEP — ${step.title}:\n${step.instruction}`);
  return parts.join('\n\n');
}

/** Build the one-turn system-prompt section for a single-shot prompt command. */
function buildPromptCommandContext(cmd: PromptCommand, targetPieceTitle: string | null): string {
  const parts: string[] = [
    `## Requested Mode: ${cmd.label}`,
    `The writer invoked this mode. Carry it out now, in your own coaching voice (this is guidance, not a script to read aloud):`,
  ];
  if (targetPieceTitle) {
    parts.push(`Piece in focus: "${targetPieceTitle}" — its full text is in The Manuscript section, or in the retrieved material if it lives outside the book.`);
  }
  parts.push(cmd.instruction);
  return parts.join('\n\n');
}

/**
 * Result of interpreting a leading-slash command.
 * - handledStatically=true means we already streamed a reply; caller returns.
 * - otherwise the caller proceeds to an LLM turn using the returned workflow
 *   state, a directive to feed Claude in place of the raw command, an optional
 *   one-shot command context section, and an optional piece to load in full.
 */
interface CommandOutcome {
  handledStatically: boolean;
  /** The one-shot mode needs everything outside the manuscript too. */
  readsWholeCorpus?: boolean;
  workflowState: WorkflowState | null;
  claudeDirective: string | null;
  commandContext: string | null;
  forcedTitle: string | null;
  preferOpus: boolean;
}

/**
 * Interpret a slash command. Returns whether it was fully handled (static
 * reply already streamed) or whether the caller should proceed to an LLM turn.
 */
async function handleSlashCommand(
  res: Response,
  sessionId: string,
  projectId: string,
  userId: string,
  projectType: string | null,
  priorState: WorkflowState | null,
  rawContent: string
): Promise<CommandOutcome> {
  const trimmed = rawContent.trim();
  const tokens = trimmed.slice(1).split(/\s+/);
  const cmd = (tokens[0] || '').toLowerCase();
  const restTokens = tokens.slice(1);

  const replyStatic = async (msg: string): Promise<CommandOutcome> => {
    await persistAssistantMessage(sessionId, msg);
    streamStaticMessage(res, msg);
    return {
      handledStatically: true,
      workflowState: priorState,
      claudeDirective: null,
      commandContext: null,
      forcedTitle: null,
      preferOpus: false,
    };
  };

  if (cmd === 'help' || cmd === 'workflows' || cmd === 'commands' || cmd === '?') {
    return replyStatic(buildHelpMenu(projectType, priorState));
  }

  // ── First-publication rights: reserve pieces for journal submission ──────
  if (cmd === 'earmark' || cmd === 'unearmark') {
    const pieceTitle = restTokens.join(' ').trim();
    if (!pieceTitle) {
      return replyStatic(
        `Name the piece — e.g. /${cmd} Fenway. Use /earmarked to see what's currently reserved.`
      );
    }
    const earmarking = cmd === 'earmark';
    const resolved = await setEarmark(projectId, pieceTitle, earmarking);
    if (!resolved) {
      return replyStatic(
        `I couldn't find a single piece matching "${pieceTitle}" in this project. Try the exact title as it appears in the binder.`
      );
    }
    return replyStatic(
      earmarking
        ? `Reserved "${resolved}" for journal submission. I'll keep it out of newsletter suggestions and flag anything that would burn its first-publication rights.`
        : `Released "${resolved}" — it's no longer reserved for journal submission.`
    );
  }

  if (cmd === 'earmarked' || cmd === 'reserved') {
    const pieces = await loadEarmarkedPieces(projectId);
    if (pieces.length === 0) {
      return replyStatic(
        'Nothing is reserved for journal submission yet. Use /earmark <title> to reserve a piece — I\'ll then keep it out of newsletter suggestions and warn if it looks published.'
      );
    }
    const conflicts = await detectFirstRightsConflicts(userId, projectId);
    const lines = [
      'Reserved for journal submission:',
      ...pieces.map((p) => `  - ${p.title} (${p.wordCount.toLocaleString()} words)`),
    ];
    if (conflicts.length > 0) {
      lines.push('', 'Possible first-rights conflicts (already on Substack):');
      for (const c of conflicts) {
        lines.push(
          `  - "${c.essayTitle}" ↔ Substack post "${c.substackTitle}" (${
            c.matchKind === 'title' ? 'same title' : 'overlapping text'
          })`
        );
      }
    }
    return replyStatic(lines.join('\n'));
  }

  // ── Quinn's notebook: what she keeps between sessions ────────────────────
  if (cmd === 'notebook' || cmd === 'notes') {
    const notebook = await loadNotebook(projectId);
    if (notebook && notebook.entries.length > 0) {
      return replyStatic(renderNotebookForWriter(notebook, await pieceIndexFor(notebook, projectId)));
    }
    if (!notebook && (await hasEndedSessions(projectId))) {
      void updateNotebook(projectId, userId); // start it from recent sessions
      return replyStatic(
        "I haven't started a notebook for this project yet. I'm reading back through our recent sessions to start one now, which takes a few minutes; try /notebook again after that. From then on I update it whenever a session ends."
      );
    }
    return replyStatic(
      'My notebook for this project is empty so far. When a session ends, I note the decisions you made, what you said about each piece, patterns I noticed, and threads to pick up next time.'
    );
  }

  if (cmd === 'forget') {
    const ids = restTokens
      .flatMap((t) => t.split(','))
      .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean)
      .map((t) => (/^\d+$/.test(t) ? `n${t}` : t));
    if (ids.length === 0) {
      return replyStatic(
        'Tell me which note to remove by its number, e.g. /forget n3 (several at once: /forget n3 n7). /notebook lists them.'
      );
    }
    const { removed, missing } = await forgetNotebookEntries(projectId, sessionId, ids);
    const lines: string[] = [];
    if (removed.length > 0) {
      lines.push('Removed from my notebook:');
      for (const e of removed) lines.push(`  ${e.id}  ${e.text}`);
    }
    if (missing.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(
        `There's no note ${missing.join(', ')} in the notebook. /notebook lists them with their numbers.`
      );
    }
    return replyStatic(lines.join('\n'));
  }

  if (cmd === 'exit' || cmd === 'stop') {
    if (priorState) {
      await saveWorkflowState(sessionId, null);
      const wf = getWorkflow(priorState.workflowId);
      return replyStatic(
        `Stepped out of ${wf ? `the ${wf.label} workflow` : 'the workflow'}. We can keep talking, or start another with /help.`
      );
    }
    return replyStatic('No workflow is running right now. Use /help to see what we can run.');
  }

  if (cmd === 'next') {
    if (!priorState) return replyStatic('No workflow is running. Use /help to start one.');
    const wf = getWorkflow(priorState.workflowId);
    if (!wf) return replyStatic('That workflow is no longer available. Use /help to start a new one.');
    const atEnd = priorState.stepIndex >= wf.steps.length - 1;
    const next = Math.min(priorState.stepIndex + 1, wf.steps.length - 1);
    const state: WorkflowState = { ...priorState, stepIndex: next };
    await saveWorkflowState(sessionId, state);
    return {
      handledStatically: false,
      workflowState: state,
      claudeDirective: atEnd
        ? `(I'm ready to finish the ${wf.label} workflow — deliver the final step.)`
        : `(I'm ready for the next step of the ${wf.label} workflow.)`,
      commandContext: null,
      forcedTitle: null,
      preferOpus: false,
    };
  }

  if (cmd === 'back' || cmd === 'previous') {
    if (!priorState) return replyStatic('No workflow is running. Use /help to start one.');
    const wf = getWorkflow(priorState.workflowId);
    if (!wf) return replyStatic('That workflow is no longer available. Use /help to start a new one.');
    const prev = Math.max(priorState.stepIndex - 1, 0);
    const state: WorkflowState = { ...priorState, stepIndex: prev };
    await saveWorkflowState(sessionId, state);
    return {
      handledStatically: false,
      workflowState: state,
      claudeDirective: `(Let's step back to the previous step of the ${wf.label} workflow.)`,
      commandContext: null,
      forcedTitle: null,
      preferOpus: false,
    };
  }

  // Single-shot prompt command (Analyze, Central Question, Coach, Progress, Check-in)?
  const promptCmd = getPromptCommand(cmd);
  if (promptCmd) {
    const arg = restTokens.join(' ').trim();
    const forcedTitle = promptCmd.targetsSinglePiece && arg ? arg : null;
    let context = buildPromptCommandContext(promptCmd, forcedTitle);

    // Submission-oriented modes get the writer's curated target venues plus the
    // live opportunity list, so suggestions rest on a controlled shortlist and
    // real open calls rather than half-remembered journals.
    if (promptCmd.includeRevisionHistory) {
      try {
        context = `${context}\n\n${await buildRevisionHistoryContext(projectId, forcedTitle)}`;
      } catch (err) {
        console.warn(
          '[Coaching] Failed to load revision history:',
          err instanceof Error ? err.message : err
        );
      }
    }

    if (promptCmd.includePublishingOpportunities) {
      context = `${context}\n\n${buildTargetVenuesContext()}`;
      try {
        const opportunities = await loadPublishingOpportunities();
        if (opportunities) context = `${context}\n\n${opportunities}`;
      } catch (err) {
        console.warn(
          '[Coaching] Failed to load publishing opportunities:',
          err instanceof Error ? err.message : err
        );
      }
    }

    return {
      handledStatically: false,
      workflowState: priorState, // prompt commands don't change workflow state
      claudeDirective: `(Run the ${promptCmd.label} mode.${forcedTitle ? ` Focus on "${forcedTitle}".` : ''})`,
      commandContext: context,
      forcedTitle,
      preferOpus: !!promptCmd.preferOpus,
      readsWholeCorpus: !!promptCmd.readsWholeCorpus,
    };
  }

  // Otherwise treat it as starting a workflow: "/essay-triage" or "/start essay-triage [piece]"
  const wfId = (cmd === 'start' ? (restTokens[0] || '') : cmd).toLowerCase();
  const startArg = (cmd === 'start' ? restTokens.slice(1) : restTokens).join(' ').trim();
  const wf = getWorkflow(wfId);

  if (!wf) {
    return replyStatic(`I don't recognize "/${cmd}". Use /help to see the commands we can run.`);
  }

  const applicable = workflowsForProjectType(projectType).some((w) => w.id === wf.id);
  if (!applicable) {
    return replyStatic(
      `The ${wf.label} workflow isn't set up for this project type. Here's what is:\n\n${buildHelpMenu(projectType, priorState)}`
    );
  }

  const state: WorkflowState = {
    workflowId: wf.id,
    stepIndex: 0,
    targetPieceTitle: wf.targetsSinglePiece && startArg ? startArg : null,
    startedAt: new Date().toISOString(),
  };
  await saveWorkflowState(sessionId, state);
  return {
    handledStatically: false,
    workflowState: state,
    claudeDirective: `(Begin the ${wf.label} workflow.${state.targetPieceTitle ? ` We're working on "${state.targetPieceTitle}".` : ''})`,
    commandContext: null,
    forcedTitle: null,
    preferOpus: false,
  };
}

/**
 * Get task-specific instructions based on the task type.
 */
function getTaskInstructions(taskType: TaskType): string {
  switch (taskType) {
    case 'coaching':
      return `You are in a coaching session. Help the writer explore their ideas, overcome blocks, and develop their craft. Ask probing questions, offer observations, and suggest techniques. Remember: coach, do not write for them.

PROTOCOL:
- Questions before answers. Pull the writer's thinking out rather than pushing your own in.
- Direct opinions are welcome, but invite the writer to push back rather than treating your read as authoritative.
- Remove shame from hard decisions — letting go of a piece, changing direction, trying something farfetched are all fine.
- Trust the darkness. Dark humor is a feature, not a bug.

TOPIC-DRIFT WATCH:
- The active project comes from the writer's navigation choice. If their message clearly concerns a different project of theirs — not a passing reference but the substantive subject — name the mismatch and ask whether they meant to switch, rather than silently coaching them in the wrong frame.

DRIFT SIGNALS (course-correct if you notice these in yourself):
- Praising more than questioning
- Writing a sentence that could plausibly appear in the writer's finished piece
- Resolving ambiguity the writer is intentionally holding open
- Generic feedback ("this is great", "consider tightening")
- Letting sentimentality pass because the subject is tender`;

    case 'editorial':
      return `You are providing editorial feedback. Flag issues (show vs. tell, pacing, voice consistency, preachiness) without rewriting. Use the "flag, don't cut" protocol. Evaluate how the work serves the central question of the active project.

PROTOCOL:
- Flag, don't cut. Suggest where prose isn't earning its keep; don't rewrite it.
- Tie observations to the project's central question when relevant.
- Preachiness, tidy endings, and tell-don't-show are top concerns for literary work. Surface them.
- For technical/journalism work (e.g., Promptly), different standards apply: clarity, accuracy, anti-hype.`;

    case 'theme_analysis':
      return `You are analyzing themes across the writer's corpus. Identify recurring motifs, narrative threads, and thematic connections between pieces. Explain how themes evolve across different works.`;

    case 'promptly_coaching':
      return `You are coaching for a Promptly post — Kevin's AI-demystification Substack for non-technical readers. Your role is to help him craft an accessible, engaging piece that explains AI concepts to a general audience.

VOICE REGISTER FOR PROMPTLY: Skeptical insider with a translator's stance. The voice of a forty-year tech veteran made accessible to readers who don't share that background. Conversational but precise. Anti-hype without anti-AI. Dark humor reserved mostly for corporate pretension and press-release-speak.

THE STANCE: Kevin is fluent in two languages — technical and general — and making one legible to speakers of the other. He is not pretending not to know things; he is choosing the comprehensible word because the goal is comprehension, not credentialing.

WHAT TRAVELS FROM HIS LITERARY VOICE:
- Self-deprecation
- Dark humor — aimed at corporate pretension and press-release-speak, not at the reader
- Anti-jargon discipline
- Trust the reader as a smart adult who just lacks context

WHAT TO LEAVE BEHIND (essay moves that are wrong for journalism):
- No tidy endings — Promptly readers want to know what happened; "we don't know yet" is fine when honest, but withholding for craft is not
- The withheld explanation — bad for translation work
- The absurd detail and the unresolved beat

COACHING PROTOCOL:
- Ask what angle excites him most about this topic. Help him find his "in" — the personal observation that makes the story his.
- Push for concrete examples and "it's like..." analogies over abstract explanations.
- Flag when explanations get too technical or when the writing tips into "teaching" rather than "sharing."
- Coach, don't write. Ask questions that help him find his own words.

CALIBRATION CHECKS (flag if a draft tips here):
- Skepticism vs. cynicism — his edge is the long-memory veteran, not the angry insider. Same skepticism, different temperature. Flag if a draft tips toward reformed-cynic territory.
- Hype — is this overselling what the technology actually does?
- Jargon — would a reader without an AI background follow this?
- Accuracy — when a claim feels shaky, surface it for him to verify.
- Voice — accessible does not mean generic; his voice should still be present.

VOICE CONSISTENCY:
- If previous Promptly posts are provided in context, reference them for tone and style consistency.
- Note recurring patterns: how he typically opens, his signature analogies, his humor style.
- Gently flag if the current approach deviates significantly from established voice.`;

    default:
      return `You are in a coaching session. Help the writer with their current needs.`;
  }
}

/**
 * Extract JSON from a Claude response that may contain markdown code blocks.
 */
function extractJSON(content: string): string {
  // Try to extract JSON from markdown code block
  const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].trim();
  }
  // Try to find raw JSON object
  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0];
  }
  return content;
}

/**
 * Load Promptly-specific context for a coaching session.
 * Includes the selected news item content and previous Promptly posts for voice consistency.
 */
async function loadPromptlyContext(
  sessionId: string,
  projectId: string
): Promise<{ context: string; historicalPostCount: number }> {
  const sections: string[] = [];

  // Find the queue item linked to this session
  const queueResult = await query<{
    id: string;
    intelligence_item_id: string;
    notes: string | null;
  }>(
    `SELECT pqi.id, pqi.intelligence_item_id, pqi.notes
     FROM promptly_queue_items pqi
     WHERE pqi.coaching_session_id = $1`,
    [sessionId]
  );

  if (queueResult.rows.length > 0) {
    const queueItem = queueResult.rows[0]!;

    // Load the source news item
    const newsResult = await query<{
      title: string;
      source: string | null;
      source_name: string | null;
      summary: string | null;
      subcategory: string | null;
    }>(
      `SELECT title, source, source_name, summary, subcategory
       FROM intelligence_items
       WHERE id = $1`,
      [queueItem.intelligence_item_id]
    );

    if (newsResult.rows.length > 0) {
      const news = newsResult.rows[0]!;
      sections.push(`## Source AI News Item\nTitle: ${news.title}\nSource: ${news.source_name || 'Unknown'}\nURL: ${news.source || 'N/A'}\nCategory: ${news.subcategory || 'general'}\nSummary: ${news.summary || 'No summary available'}`);
    }

    if (queueItem.notes) {
      sections.push(`## Writer's Notes on Angle\n${queueItem.notes}`);
    }
  }

  // Load previous Promptly posts from corpus (Substack posts for this project)
  const historicalResult = await query<{
    title: string;
    content: string;
  }>(
    `SELECT title, content FROM corpus_documents
     WHERE project_id = $1 AND source_type = 'substack'
     ORDER BY updated_at DESC
     LIMIT 5`,
    [projectId]
  );

  const historicalPostCount = historicalResult.rows.length;

  if (historicalPostCount > 0) {
    const postSummaries = historicalResult.rows.map((post) => {
      const excerpt = post.content.length > 300
        ? post.content.slice(0, 300) + '...'
        : post.content;
      return `### ${post.title}\n${excerpt}`;
    });
    sections.push(`## Previous Promptly Posts (for voice consistency)\n${postSummaries.join('\n\n')}`);
  }

  return {
    context: sections.length > 0 ? sections.join('\n\n') : '',
    historicalPostCount,
  };
}
