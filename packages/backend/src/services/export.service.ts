/**
 * Export Service
 *
 * Generates downloadable ZIP archives containing user data:
 * - Session transcripts (Markdown)
 * - Quick captures (JSON)
 * - Draft snapshots (Markdown)
 * - Project metadata (JSON)
 * - Intelligence items (JSON)
 */

import archiver from 'archiver';
import { query } from '../db/connection.js';

// In-memory buffer store for generated exports (keyed by userId)
const exportBuffers = new Map<string, Buffer>();
const exportStatuses = new Map<string, string>();

/**
 * Generate a full or per-project export as a ZIP archive.
 */
export async function generateExport(userId: string, projectId?: string): Promise<void> {
  exportStatuses.set(userId, 'generating');

  try {
    const chunks: Buffer[] = [];

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    const finalized = new Promise<void>((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });

    // Add project metadata
    await addProjectMetadata(archive, userId, projectId);

    // Add session transcripts
    await addSessionTranscripts(archive, userId, projectId);

    // Add quick captures
    await addQuickCaptures(archive, userId, projectId);

    // Add draft snapshots
    await addDraftSnapshots(archive, userId, projectId);

    // Add intelligence items
    await addIntelligenceItems(archive, userId);

    await archive.finalize();
    await finalized;

    const buffer = Buffer.concat(chunks);
    exportBuffers.set(userId, buffer);
    exportStatuses.set(userId, 'ready');
  } catch (err) {
    exportStatuses.set(userId, 'failed');
    throw err;
  }
}

/**
 * Get the current export status for a user.
 */
export function getExportStatus(userId: string): string {
  return exportStatuses.get(userId) || 'none';
}

/**
 * Get the export buffer for download.
 */
export function getExportBuffer(userId: string): Buffer | null {
  const buffer = exportBuffers.get(userId) || null;
  if (buffer) {
    // Clean up after retrieval
    exportBuffers.delete(userId);
    exportStatuses.delete(userId);
  }
  return buffer;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function addProjectMetadata(
  archive: archiver.Archiver,
  userId: string,
  projectId?: string
): Promise<void> {
  let projectsResult;

  if (projectId) {
    projectsResult = await query<{
      id: string;
      name: string;
      description: string | null;
      central_question: string | null;
      project_type: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, description, central_question, project_type, created_at, updated_at
       FROM projects WHERE id = $1 AND user_id = $2`,
      [projectId, userId]
    );
  } else {
    projectsResult = await query<{
      id: string;
      name: string;
      description: string | null;
      central_question: string | null;
      project_type: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, description, central_question, project_type, created_at, updated_at
       FROM projects WHERE user_id = $1 ORDER BY name`,
      [userId]
    );
  }

  archive.append(
    JSON.stringify(projectsResult.rows, null, 2),
    { name: 'metadata/projects.json' }
  );
}

async function addSessionTranscripts(
  archive: archiver.Archiver,
  userId: string,
  projectId?: string
): Promise<void> {
  let sessionsResult;

  if (projectId) {
    sessionsResult = await query<{
      id: string;
      project_id: string;
      session_type: string;
      summary: string | null;
      next_steps: string | null;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT s.id, s.project_id, s.session_type, s.summary, s.next_steps, s.started_at, s.ended_at
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.project_id = $1 AND p.user_id = $2
       ORDER BY s.started_at DESC`,
      [projectId, userId]
    );
  } else {
    sessionsResult = await query<{
      id: string;
      project_id: string;
      session_type: string;
      summary: string | null;
      next_steps: string | null;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT s.id, s.project_id, s.session_type, s.summary, s.next_steps, s.started_at, s.ended_at
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.user_id = $1
       ORDER BY s.started_at DESC`,
      [userId]
    );
  }

  for (const session of sessionsResult.rows) {
    // Get messages for this session
    const messagesResult = await query<{
      role: string;
      content: string;
      created_at: Date;
    }>(
      `SELECT role, content, created_at FROM messages
       WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.id]
    );

    // Build markdown transcript
    const lines: string[] = [
      `# Session: ${session.session_type}`,
      `**Started:** ${new Date(session.started_at).toISOString()}`,
      session.ended_at ? `**Ended:** ${new Date(session.ended_at).toISOString()}` : '',
      session.summary ? `\n## Summary\n${session.summary}` : '',
      session.next_steps ? `\n## Next Steps\n${session.next_steps}` : '',
      '\n## Transcript\n',
    ];

    for (const msg of messagesResult.rows) {
      const speaker = msg.role === 'user' ? '**You**' : '**Quinn**';
      lines.push(`${speaker} (${new Date(msg.created_at).toLocaleTimeString()}):\n${msg.content}\n`);
    }

    const dateStr = new Date(session.started_at).toISOString().split('T')[0];
    archive.append(lines.join('\n'), {
      name: `sessions/${dateStr}-${session.id.slice(0, 8)}.md`,
    });
  }
}

async function addQuickCaptures(
  archive: archiver.Archiver,
  userId: string,
  projectId?: string
): Promise<void> {
  let capturesResult;

  if (projectId) {
    capturesResult = await query<{
      id: string;
      project_id: string | null;
      content: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, project_id, content, status, created_at
       FROM quick_captures
       WHERE user_id = $1 AND project_id = $2
       ORDER BY created_at DESC`,
      [userId, projectId]
    );
  } else {
    capturesResult = await query<{
      id: string;
      project_id: string | null;
      content: string;
      status: string;
      created_at: Date;
    }>(
      `SELECT id, project_id, content, status, created_at
       FROM quick_captures
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
  }

  archive.append(
    JSON.stringify(capturesResult.rows, null, 2),
    { name: 'captures/quick-captures.json' }
  );
}

async function addDraftSnapshots(
  archive: archiver.Archiver,
  userId: string,
  projectId?: string
): Promise<void> {
  let snapshotsResult;

  if (projectId) {
    snapshotsResult = await query<{
      id: string;
      document_id: string;
      document_title: string;
      content: string;
      word_count: number;
      trigger: string;
      created_at: Date;
    }>(
      `SELECT ds.id, ds.document_id, cd.title as document_title, ds.content, ds.word_count, ds.trigger, ds.created_at
       FROM draft_snapshots ds
       JOIN corpus_documents cd ON cd.id = ds.document_id
       WHERE cd.project_id = $1
       ORDER BY ds.created_at DESC`,
      [projectId]
    );
  } else {
    snapshotsResult = await query<{
      id: string;
      document_id: string;
      document_title: string;
      content: string;
      word_count: number;
      trigger: string;
      created_at: Date;
    }>(
      `SELECT ds.id, ds.document_id, cd.title as document_title, ds.content, ds.word_count, ds.trigger, ds.created_at
       FROM draft_snapshots ds
       JOIN corpus_documents cd ON cd.id = ds.document_id
       JOIN projects p ON p.id = cd.project_id
       WHERE p.user_id = $1
       ORDER BY ds.created_at DESC`,
      [userId]
    );
  }

  for (const snapshot of snapshotsResult.rows) {
    const dateStr = new Date(snapshot.created_at).toISOString().split('T')[0];
    const header = [
      `# ${snapshot.document_title}`,
      `**Snapshot Date:** ${new Date(snapshot.created_at).toISOString()}`,
      `**Word Count:** ${snapshot.word_count}`,
      `**Trigger:** ${snapshot.trigger}`,
      '\n---\n',
    ].join('\n');

    archive.append(header + snapshot.content, {
      name: `snapshots/${dateStr}-${snapshot.document_title.replace(/[^a-zA-Z0-9]/g, '-')}-${snapshot.id.slice(0, 8)}.md`,
    });
  }
}

async function addIntelligenceItems(
  archive: archiver.Archiver,
  _userId: string
): Promise<void> {
  // Intelligence items are global (not per-project)
  const result = await query<{
    id: string;
    category: string;
    subcategory: string | null;
    title: string;
    source: string | null;
    source_name: string | null;
    summary: string | null;
    relevance_score: number | null;
    deadline: Date | null;
    status: string;
    discovered_at: Date;
  }>(
    `SELECT id, category, subcategory, title, source, source_name, summary,
            relevance_score, deadline, status, discovered_at
     FROM intelligence_items
     ORDER BY discovered_at DESC
     LIMIT 500`
  );

  archive.append(
    JSON.stringify(result.rows, null, 2),
    { name: 'intelligence/items.json' }
  );
}
