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

  // Load conversation history for this session
  const messagesResult = await query<MessageRow>(
    `SELECT id, session_id, role, content, model_used, model_reason, token_count_input, token_count_output, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const conversationMessages: ClaudeMessage[] = messagesResult.rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Load persona config
  const personaConfig = await loadPersonaConfig(userId);

  // Load settings for model routing preference
  const modelPreference = await loadModelRoutingPreference(userId);

  // Load session summaries for context
  const sessionSummaries = await loadSessionSummaries(session.project_id);

  // Load corpus context (recent documents)
  const corpusContext = await loadCorpusContext(session.project_id);

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
    systemPrompt: `You are a session summarizer. Given a coaching session transcript, produce:
1. A concise summary (2-3 sentences) of what was discussed and any breakthroughs or decisions made.
2. A list of next steps that were identified during the session.

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
 * Load corpus context (recent document titles/excerpts) for the project.
 */
async function loadCorpusContext(projectId: string): Promise<string[]> {
  const result = await query<{ title: string; content: string }>(
    `SELECT title, content FROM corpus_documents
     WHERE project_id = $1 AND is_folder = false
     ORDER BY updated_at DESC
     LIMIT 5`,
    [projectId]
  );

  return result.rows.map((doc) => {
    const excerpt = doc.content.length > 500
      ? doc.content.slice(0, 500) + '...'
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
      return `You are in a coaching session. Help the writer explore their ideas, overcome blocks, and develop their craft. Ask probing questions, offer observations, and suggest techniques. Remember: coach, don't write for them.`;
    case 'editorial':
      return `You are providing editorial feedback. Flag issues (show vs tell, pacing, voice consistency, preachiness) without rewriting. Use the "flag, don't cut" protocol. Evaluate how the work serves the central question.`;
    case 'theme_analysis':
      return `You are analyzing themes across the writer's corpus. Identify recurring motifs, narrative threads, and thematic connections between pieces. Explain how themes evolve across different works.`;
    case 'promptly_coaching':
      return `You are coaching for a Promptly (AI demystification) post. Your role is to help the writer craft an accessible, engaging piece that explains AI concepts to a general audience.

## Demystification Approach
- Help identify the core concept that needs explaining — what's the "so what?" for everyday people?
- Suggest framing approaches: "It's like..." analogies, everyday comparisons, historical parallels
- Encourage the writer to find the human story within the tech news
- Push for concrete examples over abstract explanations
- Help identify what the reader already knows that connects to this new concept

## Audience Awareness
- The audience is curious non-technical readers who want to understand AI without jargon
- Avoid: technical terminology without explanation, assumed knowledge of ML/CS concepts
- Encourage: conversational tone, humor, self-deprecation, admitting what's genuinely confusing
- The goal is empowerment, not intimidation — readers should feel smarter after reading

## Voice Consistency
- If previous Promptly posts are provided in context, reference them for tone and style consistency
- Note recurring patterns: how the writer typically opens, their signature analogies, their humor style
- Gently flag if the current approach deviates significantly from established voice
- Suggest ways to connect this piece to themes from previous posts

## Coaching Protocol
- Ask what angle excites the writer most about this topic
- Help them find their "in" — the personal connection or observation that makes it theirs
- Suggest structural approaches (narrative arc, Q&A format, myth-busting, day-in-the-life)
- Flag when explanations get too technical or when the writer is "teaching" instead of "sharing"
- Remember: coach, don't write. Ask questions that help them find their own words.`;
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
