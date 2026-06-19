import { Response } from 'express';
import { query } from '../db/connection.js';
import {
  sendMessage,
  streamToSSE,
  assembleSystemPrompt,
  determineModel,
  type ClaudeMessage,
  type ClaudeResponse,
  type ModelSelection,
  type ModelRoutingPreference,
  type ProjectContext,
  type SessionSummary,
  type TaskType,
} from './claude-api.service.js';
import { getEthicsPrompt, checkEthicsViolation, logEthicsBoundary } from './ethics.service.js';
import { logApiUsage } from './usage-tracking.service.js';
import { getRecentActivitySummary } from './activity.service.js';
import { ensureCorpusSummaries } from './corpus-summary.service.js';
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

// ─── Start Session ───────────────────────────────────────────────────────────

/**
 * Start a new coaching session for a project.
 * Creates the session in DB, loads project context, checks stale corpus and inactivity gap.
 */
export async function startSession(
  userId: string,
  projectId: string,
  sessionType: SessionType
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

  // Load last 3 session summaries
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
  if (sessionType === 'coaching') {
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
  const corpusChanges = await loadCorpusChangesSinceLastSession(projectId);
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
    throw new Error('Session has already ended');
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

  if (content.trim().startsWith('/')) {
    const outcome = await handleSlashCommand(
      res,
      sessionId,
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
  }

  // Load conversation history for this session (windowed to last 20 messages
  // to prevent context overflow in long sessions)
  const messagesResult = await query<MessageRow>(
    `SELECT id, session_id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const allMessages = messagesResult.rows
    .filter((m) => m.role === 'user' || m.role === 'assistant');

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

  // Keep the last 20 messages (10 exchanges) for context.
  // If we're windowing, prepend a brief note so Quinn knows there's prior history.
  const WINDOW_SIZE = 20;
  let conversationMessages: ClaudeMessage[];
  if (convoPairs.length > WINDOW_SIZE) {
    const windowed = convoPairs.slice(-WINDOW_SIZE);
    conversationMessages = [
      {
        role: 'user' as const,
        content: `[Note: This session has ${convoPairs.length} messages total. Showing the most recent ${WINDOW_SIZE} for context. Refer to Session Memory above for earlier topics.]`,
      },
      {
        role: 'assistant' as const,
        content: `[Understood — I have our earlier conversation in memory via the session history.]`,
      },
      ...windowed,
    ];
  } else {
    conversationMessages = convoPairs;
  }

  // The Anthropic API requires the conversation to begin with a user turn.
  // A session may open with Quinn's proactive greeting (an assistant message),
  // so drop any leading assistant turns.
  while (conversationMessages.length > 0 && conversationMessages[0]!.role === 'assistant') {
    conversationMessages.shift();
  }

  // Load persona config
  const personaConfig = await loadPersonaConfig(userId);

  // Load settings for model routing preference
  const modelPreference = await loadModelRoutingPreference(userId);

  // Load session summaries for context
  const sessionSummaries = await loadSessionSummaries(session.project_id);

  // Load corpus context — relevant documents based on the user's message,
  // plus a baseline of documents for general awareness. A workflow or command
  // targeting a single piece forces that piece's full text into context.
  const forcedTitles = [workflowState?.targetPieceTitle, commandForcedTitle].filter(
    (t): t is string => !!t
  );
  const corpusContext = await loadCorpusContext(session.project_id, content, forcedTitles);

  // Load the full manuscript map (Scrivener binder structure) so Quinn always
  // knows what exists and where, even when content excerpts are budget-limited.
  const manuscriptMap = await loadManuscriptMap(session.project_id);

  // Check inactivity for context
  const inactivityDays = await checkInactivityGap(session.project_id);

  // Load stale threshold for welcome-back detection
  const userSettings = await query<{ stale_corpus_threshold_days: number | null }>(
    `SELECT stale_corpus_threshold_days FROM settings WHERE user_id = $1`,
    [userId]
  );
  const staleThreshold = userSettings.rows[0]?.stale_corpus_threshold_days ?? 7;

  // Build activity context with welcome-back note if inactivity exceeds threshold
  let activityContext: string | null = null;
  if (inactivityDays !== null && inactivityDays > staleThreshold) {
    activityContext = `WELCOME BACK: It has been ${inactivityDays} days since the last coaching session for this project. The writer has been away for a while. Acknowledge their return warmly, ask what brought them back, and gently reconnect them with where they left off. Reference the previous session summaries to help them pick up the thread.`;
  } else if (inactivityDays !== null && inactivityDays > 0) {
    activityContext = `It has been ${inactivityDays} day${inactivityDays > 1 ? 's' : ''} since the last coaching session for this project.`;
  }

  // Load recent activity summary and append to activity context
  const recentActivity = await getRecentActivitySummary(userId, session.project_id);
  if (recentActivity) {
    activityContext = activityContext
      ? `${activityContext}\n\n${recentActivity}`
      : recentActivity;
  }

  // Load corpus changes since the last coaching session — so Quinn knows
  // exactly what the writer added, revised, or removed in Scrivener.
  const corpusChanges = await loadCorpusChangesSinceLastSession(session.project_id);
  if (corpusChanges) {
    activityContext = activityContext
      ? `${activityContext}\n\n${corpusChanges}`
      : corpusChanges;
  }

  // Determine task type for model routing
  const taskType: TaskType = session.session_type === 'editorial_review'
    ? 'editorial'
    : session.session_type === 'theme_analysis'
      ? 'theme_analysis'
      : session.session_type === 'promptly_coaching'
        ? 'promptly_coaching'
        : 'coaching';

  // Load Promptly-specific context if applicable
  let promptlyContext: string | null = null;
  let historicalPostCount = 0;
  if (session.session_type === 'promptly_coaching') {
    const promptlyData = await loadPromptlyContext(sessionId, session.project_id);
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
  let workflowPrefersOpus = commandPreferOpus;
  if (workflowState) {
    const activeWfForModel = getWorkflow(workflowState.workflowId);
    if (activeWfForModel?.preferOpus) workflowPrefersOpus = true;
  }
  if (workflowPrefersOpus && modelPreference === 'auto' && routingDecision.model !== 'opus') {
    routingDecision.model = 'opus';
    routingDecision.reason = 'Deep coaching mode — using Opus for fuller analysis';
  }

  // Build combined activity context with Promptly context
  let combinedActivityContext = activityContext;
  if (promptlyContext) {
    combinedActivityContext = combinedActivityContext
      ? `${combinedActivityContext}\n\n${promptlyContext}`
      : promptlyContext;
  }

  // Build the active-workflow system section (if a workflow is running).
  let workflowContext: string | null = null;
  if (workflowState) {
    const activeWf = getWorkflow(workflowState.workflowId);
    if (activeWf) {
      workflowContext = buildWorkflowContext(activeWf, workflowState);
    }
  }

  // Assemble system prompt
  const systemPrompt = assembleSystemPrompt({
    personaConfig,
    projectContext: {
      name: project.name,
      centralQuestion: project.central_question,
      description: project.description,
    },
    manuscriptMap,
    workflowContext,
    commandContext,
    sessionHistories: sessionSummaries,
    corpusContext,
    activityContext: combinedActivityContext,
    taskInstructions: getTaskInstructions(taskType),
    ethicsPrompt: getEthicsPrompt(),
    model: routingDecision.model,
  });

  // Stream response via SSE
  const { promise } = streamToSSE(res, {
    systemPrompt,
    messages: conversationMessages,
    model: routingDecision.model,
    modelReason: routingDecision.reason,
  });

  // Wait for stream to complete
  const claudeResponse: ClaudeResponse = await promise;

  // Persist assistant message
  await query(
    `INSERT INTO messages (session_id, role, content, model_used, model_reason, token_count_input, token_count_output)
     VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
    [
      sessionId,
      claudeResponse.content,
      claudeResponse.model,
      routingDecision.reason,
      claudeResponse.inputTokens,
      claudeResponse.outputTokens,
    ]
  );

  // Log API usage
  await logApiUsage(
    userId,
    claudeResponse.model,
    taskType,
    claudeResponse.inputTokens,
    claudeResponse.outputTokens
  );

  // Check ethics violations
  if (checkEthicsViolation(claudeResponse.content)) {
    await logEthicsBoundary(userId, sessionId, content, claudeResponse.content);
  }
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

  if (session.ended_at) {
    throw new Error('Session has already ended');
  }

  // Verify project ownership
  const projectResult = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM projects WHERE id = $1 AND user_id = $2`,
    [session.project_id, userId]
  );

  if (projectResult.rows.length === 0) {
    throw new Error('Project not found or access denied');
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
    });

    summaryModel = summaryResponse.model;
    summaryInputTokens = summaryResponse.inputTokens;
    summaryOutputTokens = summaryResponse.outputTokens;

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
    summary = `Session on ${new Date().toLocaleDateString()} with ${messageCount} messages exchanged. (Summary could not be generated automatically.)`;
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

  return { summary, nextSteps };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Load a summary of corpus changes (added/modified/deleted documents)
 * from Scrivener imports that occurred since the writer's last completed
 * coaching session. This lets Quinn know exactly what changed in the
 * writer's manuscript since they last talked.
 */
async function loadCorpusChangesSinceLastSession(projectId: string): Promise<string | null> {
  // Find when the last completed session ended
  const lastSession = await query<{ ended_at: Date }>(
    `SELECT ended_at FROM sessions
     WHERE project_id = $1 AND ended_at IS NOT NULL
     ORDER BY ended_at DESC
     LIMIT 1`,
    [projectId]
  );

  const since = lastSession.rows[0]?.ended_at ?? null;

  // Load imports since that time (or the most recent import if no prior session)
  const imports = await query<{
    diff_summary: {
      added?: Array<{ title: string }>;
      modified?: Array<{ title: string; oldWordCount: number; newWordCount: number }>;
      deleted?: Array<{ title: string }>;
    } | null;
    imported_at: Date;
  }>(
    since
      ? `SELECT diff_summary, imported_at FROM scrivener_imports
         WHERE project_id = $1 AND imported_at > $2
         ORDER BY imported_at ASC`
      : `SELECT diff_summary, imported_at FROM scrivener_imports
         WHERE project_id = $1
         ORDER BY imported_at DESC
         LIMIT 1`,
    since ? [projectId, since] : [projectId]
  );

  if (imports.rows.length === 0) {
    return null;
  }

  // Aggregate changes across all imports since last session
  const added = new Set<string>();
  const modified = new Map<string, { oldWordCount: number; newWordCount: number }>();
  const deleted = new Set<string>();

  for (const imp of imports.rows) {
    const diff = imp.diff_summary;
    if (!diff) continue;
    for (const a of diff.added ?? []) added.add(a.title);
    for (const m of diff.modified ?? []) {
      modified.set(m.title, { oldWordCount: m.oldWordCount, newWordCount: m.newWordCount });
    }
    for (const d of diff.deleted ?? []) deleted.add(d.title);
  }

  // A title might be both added and modified across imports — added wins
  for (const title of added) modified.delete(title);

  if (added.size === 0 && modified.size === 0 && deleted.size === 0) {
    return null;
  }

  const lines: string[] = [
    since
      ? "CHANGES TO THE MANUSCRIPT SINCE YOUR LAST SESSION: The writer has been working in Scrivener. Here's exactly what changed. Acknowledge this naturally — you noticed their work."
      : "RECENT MANUSCRIPT CHANGES: Here's what changed in the writer's most recent Scrivener sync.",
  ];

  if (added.size > 0) {
    lines.push(`\nNew pieces added:\n${[...added].map((t) => `- ${t}`).join('\n')}`);
  }
  if (modified.size > 0) {
    lines.push(
      `\nPieces revised:\n${[...modified.entries()]
        .map(([title, wc]) => {
          const delta = wc.newWordCount - wc.oldWordCount;
          const sign = delta >= 0 ? '+' : '';
          return `- ${title} (${sign}${delta} words, now ${wc.newWordCount})`;
        })
        .join('\n')}`
    );
  }
  if (deleted.size > 0) {
    lines.push(`\nPieces removed:\n${[...deleted].map((t) => `- ${t}`).join('\n')}`);
  }

  return lines.join('\n');
}

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
 * Load summaries of the last 3 sessions for a project.
 */
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
     LIMIT 3`,
    [projectId]
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
 * because it carries titles and counts only, no document bodies.
 *
 * Returns null if the project has no Scrivener documents yet.
 */
async function loadManuscriptMap(projectId: string): Promise<string | null> {
  const result = await query<{
    id: string;
    title: string;
    word_count: number | null;
    parent_id: string | null;
    sort_order: number | null;
    is_folder: boolean;
    metadata: { scrivenerType?: string | null; summary?: string | null } | null;
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

  const sortNodes = (nodes: CorpusNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);

  // Tally totals so Quinn knows the true size of the binder (and won't assume
  // there's hidden material when the list is actually complete).
  let folderCount = 0;
  let docCount = 0;
  let totalWords = 0;
  const tally = (nodes: CorpusNode[]): void => {
    for (const n of nodes) {
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

  // Count the documents (non-folders) anywhere beneath a folder.
  const countDocsUnder = (node: CorpusNode): number =>
    node.children.reduce(
      (sum, child) => sum + (child.isFolder ? 0 : 1) + countDocsUnder(child),
      0
    );

  // Render an indented outline.
  const lines: string[] = [
    `Binder contains ${folderCount} folder${folderCount === 1 ? '' : 's'} and ${docCount} document${docCount === 1 ? '' : 's'} (${totalWords.toLocaleString()} words total). This list is COMPLETE — every imported piece appears below. If a piece is not listed here, it has not been synced into this project (so don't claim hidden material exists when it doesn't, and don't invent pieces).`,
    '',
  ];
  const MAX_CHARS = 24000; // soft cap so an enormous binder can't dominate the prompt
  let truncated = false;
  let renderedChars = 0;

  const render = (nodes: CorpusNode[], depth: number): void => {
    for (const node of nodes) {
      if (renderedChars > MAX_CHARS) {
        truncated = true;
        return;
      }
      const indent = '  '.repeat(depth);
      let line: string;
      if (node.isFolder) {
        const role = folderRoleLabel(node.scrivenerType);
        const roleTag = role ? ` [${role}]` : '';
        const pieces = countDocsUnder(node);
        line = `${indent}${node.title}/${roleTag} — ${pieces} piece${pieces === 1 ? '' : 's'}, ${node.wordCount.toLocaleString()} words`;
      } else {
        line = `${indent}${node.title} — ${node.wordCount.toLocaleString()} words`;
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
  trashIds: Set<string>
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
    if (trashIds.has(row.id)) continue;
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
 * Load corpus context (document excerpts) for the project.
 *
 * Three strategies, in priority order:
 * 0. Named: documents the writer references by title (or a workflow forces) are
 *    loaded as FULL text, not excerpts, so deep work on a specific piece is exact.
 * 1. Relevance: documents whose title or content matches keywords in the
 *    user's current message (so asking about a topic surfaces related pieces).
 * 2. Baseline: documents in true binder order, so Quinn has general awareness
 *    of the manuscript even for vague messages.
 *
 * Trash is always excluded. Entries are ordered named-first, then relevant, then
 * baseline; the system prompt's token budget decides how many actually fit.
 */
async function loadCorpusContext(
  projectId: string,
  userMessage?: string,
  forcedTitles: string[] = []
): Promise<string[]> {
  const seen = new Set<string>();
  const docs: Array<{ title: string; content: string; full?: boolean }> = [];
  const trashIds = await loadTrashDocumentIds(projectId);

  // 0. Named / forced documents — full text, highest priority.
  const named = await loadNamedDocuments(projectId, userMessage, forcedTitles, trashIds);
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

  // 1. Relevance-matched documents (if we have a message to match against)

  if (userMessage && userMessage.trim().length > 0) {
    // Build a tsquery from the message words (OR-joined, prefix-matched)
    const keywords = userMessage
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3) // skip short/common words
      .slice(0, 12);

    if (keywords.length > 0) {
      const tsquery = keywords.map((w) => `${w}:*`).join(' | ');
      try {
        const relevant = await query<{ id: string; title: string; content: string }>(
          `SELECT id, title, content,
                  ts_rank(
                    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')),
                    to_tsquery('english', $2)
                  ) AS rank
           FROM corpus_documents
           WHERE project_id = $1
             AND is_folder = false
             AND content != ''
             AND to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')) @@ to_tsquery('english', $2)
           ORDER BY rank DESC
           LIMIT 15`,
          [projectId, tsquery]
        );

        for (const row of relevant.rows) {
          if (trashIds.has(row.id)) continue; // never surface deleted work
          if (!seen.has(row.id)) {
            seen.add(row.id);
            docs.push({ title: row.title, content: row.content });
          }
        }
      } catch (err) {
        // Full-text query can fail on malformed input — fall through to baseline
        console.warn('[Corpus] Relevance search failed, using baseline only:', err instanceof Error ? err.message : err);
      }
    }
  }

  // 2. Baseline documents (excluding trash). Scrivener projects use true binder
  // order; non-Scrivener projects (Substack/Promptly) have no binder, so their
  // docs are ordered by recency. Combine so mixed or either-type projects work.
  const BASELINE_LIMIT = 40;
  const scrivenerLeafIds = await loadBinderLeafOrder(projectId, trashIds);
  const nonScrivener = await query<{ id: string }>(
    `SELECT id FROM corpus_documents
     WHERE project_id = $1 AND source_type != 'scrivener' AND is_folder = false AND content != ''
     ORDER BY updated_at DESC
     LIMIT $2`,
    [projectId, BASELINE_LIMIT]
  );
  const orderedBaseline = [...scrivenerLeafIds, ...nonScrivener.rows.map((r) => r.id)];
  const baselineIds = orderedBaseline.filter((id) => !seen.has(id)).slice(0, BASELINE_LIMIT);

  if (baselineIds.length > 0) {
    const baseline = await query<{ id: string; title: string; content: string }>(
      `SELECT id, title, content FROM corpus_documents
       WHERE id = ANY($1::uuid[]) AND content != ''`,
      [baselineIds]
    );
    const byId = new Map(baseline.rows.map((r) => [r.id, r]));
    // Preserve the combined order from baselineIds
    for (const id of baselineIds) {
      const row = byId.get(id);
      if (row && !seen.has(id)) {
        seen.add(id);
        docs.push({ title: row.title, content: row.content });
      }
    }
  }

  return docs.map((doc) => {
    if (doc.full) {
      return `### ${doc.title} (FULL TEXT)\n${doc.content}`;
    }
    const excerpt = doc.content.length > 3000
      ? doc.content.slice(0, 3000) + '...'
      : doc.content;
    return `### ${doc.title}\n${excerpt}`;
  });
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
    parts.push(`Working piece: "${state.targetPieceTitle}" — its full text should be loaded in the corpus context below.`);
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
    parts.push(`Piece in focus: "${targetPieceTitle}" — its full text should be loaded in the corpus context below.`);
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
    return {
      handledStatically: false,
      workflowState: priorState, // prompt commands don't change workflow state
      claudeDirective: `(Run the ${promptCmd.label} mode.${forcedTitle ? ` Focus on "${forcedTitle}".` : ''})`,
      commandContext: buildPromptCommandContext(promptCmd, forcedTitle),
      forcedTitle,
      preferOpus: !!promptCmd.preferOpus,
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
