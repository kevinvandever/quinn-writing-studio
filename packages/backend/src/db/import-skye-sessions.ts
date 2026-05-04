/**
 * Import Kevin's Skye-era coaching sessions from Claude Code history.
 *
 * These are Kevin's messages only (Quinn's responses weren't persisted
 * by Claude Code). Each session is created with a note that Quinn's
 * responses are not available but the session context is preserved.
 *
 * Run with:
 *   DATABASE_URL="..." npm run db:import-skye -w @quinn/backend
 */
import { readFileSync } from 'fs';
import { pool } from './connection.js';

const KEVIN_USER_ID = '7027ade0-aeee-485b-8071-9df81ab70f32';
const ESSAY_PROJECT_ID = 'a4509dae-b732-4a9f-9aa0-af4958c14cee';

interface HistoryMessage {
  timestamp: number;
  content: string;
  date: string;
}

type SessionMap = Record<string, HistoryMessage[]>;

async function importSkyeSessions(): Promise<void> {
  // Load the extracted session data
  const raw = readFileSync('/tmp/quinn-skye-sessions.json', 'utf-8');
  const sessions: SessionMap = JSON.parse(raw);

  const client = await pool.connect();
  let totalSessions = 0;
  let totalMessages = 0;

  try {
    await client.query('BEGIN');

    for (const [_sessionId, messages] of Object.entries(sessions)) {
      if (messages.length === 0) continue;

      // Filter out empty messages and command-only messages
      const meaningfulMessages = messages.filter((m) => {
        const content = m.content.trim();
        if (!content) return false;
        // Keep Quinn activation commands as context markers
        if (content === '/exit') return false;
        if (content === '/clear') return false;
        return true;
      });

      if (meaningfulMessages.length === 0) continue;

      const firstMsg = meaningfulMessages[0]!;
      const lastMsg = meaningfulMessages[meaningfulMessages.length - 1]!;
      const startedAt = new Date(firstMsg.timestamp);
      const endedAt = new Date(lastMsg.timestamp);

      // Build a summary from the messages
      const contentPreviews = meaningfulMessages
        .filter((m) => !m.content.startsWith('/BMad'))
        .slice(0, 5)
        .map((m) => m.content.slice(0, 120))
        .join(' | ');

      const summary = `[Imported from Claude Code — Skye sabbatical] ${contentPreviews}`;

      // Create the session
      const sessionResult = await client.query<{ id: string }>(
        `INSERT INTO sessions (project_id, session_type, summary, started_at, ended_at)
         VALUES ($1, 'coaching', $2, $3, $4)
         RETURNING id`,
        [ESSAY_PROJECT_ID, summary.slice(0, 1000), startedAt, endedAt]
      );

      const sessionId = sessionResult.rows[0]!.id;
      totalSessions++;

      // Add a system message noting the import context
      await client.query(
        `INSERT INTO messages (session_id, role, content, created_at)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          '[This session was imported from Claude Code history. Only Kevin\'s messages are available — Quinn\'s responses were not persisted by Claude Code. The conversation context is preserved for continuity.]',
          startedAt,
        ]
      );

      // Insert each message
      for (const msg of meaningfulMessages) {
        const content = msg.content.trim();
        if (!content) continue;

        // Quinn activation commands become system messages
        const isCommand = content.startsWith('/BMad') || content.startsWith('/quinn');
        const role = isCommand ? 'system' : 'user';
        const messageContent = isCommand
          ? `[Quinn activated: ${content}]`
          : content;

        await client.query(
          `INSERT INTO messages (session_id, role, content, created_at)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, role, messageContent, new Date(msg.timestamp)]
        );
        totalMessages++;
      }

      // Log activity event
      await client.query(
        `INSERT INTO activity_events (user_id, project_id, event_type, metadata, created_at)
         VALUES ($1, $2, 'session_start', $3, $4)`,
        [
          KEVIN_USER_ID,
          ESSAY_PROJECT_ID,
          JSON.stringify({
            imported: true,
            source: 'claude_code_history',
            message_count: meaningfulMessages.length,
          }),
          startedAt,
        ]
      );
    }

    await client.query('COMMIT');

    console.log('Import complete.');
    console.log(`  Sessions created: ${totalSessions}`);
    console.log(`  Messages imported: ${totalMessages}`);
    console.log(`  Project: Essay Collection (${ESSAY_PROJECT_ID})`);
    console.log('');
    console.log('Note: Only Kevin\'s messages are present. Quinn\'s responses');
    console.log('were not persisted by Claude Code. Each session has a system');
    console.log('message noting this for context.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Import failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

importSkyeSessions().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
