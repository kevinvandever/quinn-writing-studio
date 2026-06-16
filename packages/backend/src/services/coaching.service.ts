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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionContext {
  sessionId: string;
  projectId: string;
  sessionType: SessionType;
  project: ProjectContext;
  staleCorpus: boolean;
  inactivityDays: number | null;
  sessionSummaries: SessionSummary[];
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
  };
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
  }>(
    `SELECT id, user_id, name, central_question, description
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

  // Keep the last 20 messages (10 exchanges) for context.
  // If we're windowing, prepend a brief note so Quinn knows there's prior history.
  const WINDOW_SIZE = 20;
  let conversationMessages: ClaudeMessage[];
  if (allMessages.length > WINDOW_SIZE) {
    const windowed = allMessages.slice(-WINDOW_SIZE);
    conversationMessages = [
      {
        role: 'user' as const,
        content: `[Note: This session has ${allMessages.length} messages total. Showing the most recent ${WINDOW_SIZE} for context. Refer to Session Memory above for earlier topics.]`,
      },
      {
        role: 'assistant' as const,
        content: `[Understood — I have our earlier conversation in memory via the session history.]`,
      },
      ...windowed.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];
  } else {
    conversationMessages = allMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  }

  // Load persona config
  const personaConfig = await loadPersonaConfig(userId);

  // Load settings for model routing preference
  const modelPreference = await loadModelRoutingPreference(userId);

  // Load session summaries for context
  const sessionSummaries = await loadSessionSummaries(session.project_id);

  // Load corpus context — relevant documents based on the user's message,
  // plus a baseline of documents for general awareness.
  const corpusContext = await loadCorpusContext(session.project_id, content);

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

  // Build combined activity context with Promptly context
  let combinedActivityContext = activityContext;
  if (promptlyContext) {
    combinedActivityContext = combinedActivityContext
      ? `${combinedActivityContext}\n\n${promptlyContext}`
      : promptlyContext;
  }

  // Assemble system prompt
  const systemPrompt = assembleSystemPrompt({
    personaConfig,
    projectContext: {
      name: project.name,
      centralQuestion: project.central_question,
      description: project.description,
    },
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

  // Parse the summary response
  let summary = '';
  let nextSteps = '';

  try {
    const parsed = JSON.parse(extractJSON(summaryResponse.content));
    summary = parsed.summary || '';
    nextSteps = parsed.next_steps || '';
  } catch {
    // If JSON parsing fails, use the raw content as summary
    summary = summaryResponse.content;
    nextSteps = '';
  }

  // Update session with summary and end time
  await query(
    `UPDATE sessions
     SET summary = $1, next_steps = $2, ended_at = NOW()
     WHERE id = $3`,
    [summary, nextSteps, sessionId]
  );

  // Log API usage for summary generation
  await logApiUsage(
    userId,
    summaryResponse.model,
    'coaching',
    summaryResponse.inputTokens,
    summaryResponse.outputTokens
  );

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

/**
 * Load corpus context for the project.
 *
 * Combines two strategies:
 * 1. Relevance: documents whose title or content matches keywords in the
 *    user's current message (so asking about a specific essay surfaces it).
 * 2. Baseline: a set of documents ordered by binder position, so Quinn
 *    always has general awareness of the project even for vague messages.
 *
 * Returns up to ~25 documents total, de-duplicated, relevant ones first.
 */
async function loadCorpusContext(projectId: string, userMessage?: string): Promise<string[]> {
  const seen = new Set<string>();
  const docs: Array<{ title: string; content: string }> = [];

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
           LIMIT 10`,
          [projectId, tsquery]
        );

        for (const row of relevant.rows) {
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

  // 2. Baseline documents by binder order (stable, predictable)
  const baseline = await query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM corpus_documents
     WHERE project_id = $1 AND is_folder = false AND content != ''
     ORDER BY sort_order ASC
     LIMIT 25`,
    [projectId]
  );

  for (const row of baseline.rows) {
    if (docs.length >= 25) break;
    if (!seen.has(row.id)) {
      seen.add(row.id);
      docs.push({ title: row.title, content: row.content });
    }
  }

  return docs.map((doc) => {
    const excerpt = doc.content.length > 3000
      ? doc.content.slice(0, 3000) + '...'
      : doc.content;
    return `### ${doc.title}\n${excerpt}`;
  });
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
