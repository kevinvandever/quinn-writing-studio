/**
 * Theme Analysis Service
 *
 * Scans corpus across all projects via Claude Opus to identify
 * recurring themes and narrative threads, storing connections
 * in theme_connections with explanations and strength scores.
 */

import { query, getClient } from '../db/connection.js';
import { sendMessage } from './claude-api.service.js';

export interface ThemeConnection {
  id: string;
  document_a_id: string;
  document_b_id: string;
  theme: string;
  explanation: string;
  strength: number;
  discovered_at: Date;
}

export interface DocumentSummary {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  content: string;
  word_count: number;
}

interface DiscoveredTheme {
  documentAId: string;
  documentBId: string;
  theme: string;
  explanation: string;
  strength: number;
}

/**
 * Run cross-project theme analysis for a user.
 * Scans all corpus documents and identifies thematic connections.
 */
export async function analyzeThemes(userId: string): Promise<ThemeConnection[]> {
  // Load all corpus documents across all projects
  const documents = await loadUserDocuments(userId);

  if (documents.length < 2) {
    return [];
  }

  // Build document summaries for Claude (truncate long documents)
  const documentSummaries = documents.map((doc) => ({
    id: doc.id,
    projectName: doc.project_name,
    title: doc.title,
    excerpt: doc.content.slice(0, 2000), // First 2000 chars as excerpt
  }));

  // Send to Claude Opus for theme analysis
  const discoveredThemes = await identifyThemes(documentSummaries);

  // Store discovered connections
  const client = await getClient();
  const storedConnections: ThemeConnection[] = [];

  try {
    await client.query('BEGIN');

    // Clear existing theme connections for this user's documents
    const docIds = documents.map((d) => d.id);
    if (docIds.length > 0) {
      await client.query(
        `DELETE FROM theme_connections
         WHERE document_a_id = ANY($1) OR document_b_id = ANY($1)`,
        [docIds]
      );
    }

    // Insert new connections
    for (const theme of discoveredThemes) {
      const result = await client.query<ThemeConnection>(
        `INSERT INTO theme_connections (document_a_id, document_b_id, theme, explanation, strength)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, document_a_id, document_b_id, theme, explanation, strength, discovered_at`,
        [theme.documentAId, theme.documentBId, theme.theme, theme.explanation, theme.strength]
      );

      if (result.rows[0]) {
        storedConnections.push(result.rows[0]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return storedConnections;
}

/**
 * Check a single new document for thematic connections to existing documents.
 */
export async function checkDocumentThemes(
  userId: string,
  newDocumentId: string
): Promise<ThemeConnection[]> {
  // Load the new document
  const newDocResult = await query<DocumentSummary>(
    `SELECT cd.id, cd.project_id, p.name as project_name, cd.title, cd.content, cd.word_count
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.id = $1 AND p.user_id = $2`,
    [newDocumentId, userId]
  );

  if (newDocResult.rows.length === 0) return [];

  const newDoc = newDocResult.rows[0]!;

  // Load existing documents (excluding the new one)
  const existingDocs = await query<DocumentSummary>(
    `SELECT cd.id, cd.project_id, p.name as project_name, cd.title, cd.content, cd.word_count
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE p.user_id = $1 AND cd.id != $2 AND cd.is_folder = false
     ORDER BY cd.word_count DESC
     LIMIT 20`,
    [userId, newDocumentId]
  );

  if (existingDocs.rows.length === 0) return [];

  // Build summaries for comparison
  const newDocSummary = {
    id: newDoc.id,
    projectName: newDoc.project_name,
    title: newDoc.title,
    excerpt: newDoc.content.slice(0, 2000),
  };

  const existingSummaries = existingDocs.rows.map((doc) => ({
    id: doc.id,
    projectName: doc.project_name,
    title: doc.title,
    excerpt: doc.content.slice(0, 1500),
  }));

  // Ask Claude to find connections
  const themes = await findConnectionsForDocument(newDocSummary, existingSummaries);

  // Store connections
  const storedConnections: ThemeConnection[] = [];

  for (const theme of themes) {
    const result = await query<ThemeConnection>(
      `INSERT INTO theme_connections (document_a_id, document_b_id, theme, explanation, strength)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, document_a_id, document_b_id, theme, explanation, strength, discovered_at`,
      [theme.documentAId, theme.documentBId, theme.theme, theme.explanation, theme.strength]
    );

    if (result.rows[0]) {
      storedConnections.push(result.rows[0]);
    }
  }

  return storedConnections;
}

/**
 * Get the theme map for a user (all connections with document details).
 */
export async function getThemeMap(userId: string) {
  const result = await query<{
    id: string;
    document_a_id: string;
    document_a_title: string;
    document_a_project: string;
    document_b_id: string;
    document_b_title: string;
    document_b_project: string;
    theme: string;
    explanation: string;
    strength: number;
    discovered_at: Date;
  }>(
    `SELECT tc.id, tc.document_a_id,
            da.title as document_a_title, pa.name as document_a_project,
            tc.document_b_id,
            db.title as document_b_title, pb.name as document_b_project,
            tc.theme, tc.explanation, tc.strength, tc.discovered_at
     FROM theme_connections tc
     JOIN corpus_documents da ON da.id = tc.document_a_id
     JOIN projects pa ON pa.id = da.project_id
     JOIN corpus_documents db ON db.id = tc.document_b_id
     JOIN projects pb ON pb.id = db.project_id
     WHERE pa.user_id = $1
     ORDER BY tc.strength DESC, tc.discovered_at DESC`,
    [userId]
  );

  return result.rows;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function loadUserDocuments(userId: string): Promise<DocumentSummary[]> {
  const result = await query<DocumentSummary>(
    `SELECT cd.id, cd.project_id, p.name as project_name, cd.title, cd.content, cd.word_count
     FROM corpus_documents cd
     JOIN projects p ON p.id = cd.project_id
     WHERE p.user_id = $1 AND cd.is_folder = false AND cd.content IS NOT NULL
     ORDER BY cd.word_count DESC
     LIMIT 50`,
    [userId]
  );

  return result.rows;
}

async function identifyThemes(
  documents: Array<{ id: string; projectName: string; title: string; excerpt: string }>
): Promise<DiscoveredTheme[]> {
  const systemPrompt = `You are a literary analyst specializing in identifying thematic connections across a writer's body of work. You look for recurring themes, narrative threads, stylistic patterns, and conceptual links between documents.

Analyze the provided documents and identify meaningful thematic connections between pairs of documents. Focus on:
- Recurring themes (memory, identity, place, relationships, etc.)
- Narrative threads that span multiple pieces
- Stylistic or tonal similarities
- Shared imagery or metaphors
- Complementary perspectives on the same topic

Return your analysis as a JSON array of connections. Each connection should have:
- documentAId: the ID of the first document
- documentBId: the ID of the second document
- theme: a short theme label (2-5 words)
- explanation: a 1-2 sentence explanation of the connection
- strength: a score from 0.1 to 1.0 indicating connection strength

Only include meaningful connections (strength >= 0.3). Return at most 20 connections.
Return ONLY the JSON array, no other text.`;

  const userMessage = `Here are the documents to analyze:\n\n${documents
    .map((d) => `[Document ID: ${d.id}]\nProject: ${d.projectName}\nTitle: ${d.title}\nExcerpt:\n${d.excerpt}\n---`)
    .join('\n\n')}`;

  const response = await sendMessage({
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    model: 'opus',
  });

  try {
    const parsed = JSON.parse(response.content) as DiscoveredTheme[];
    // Validate document IDs exist in our set
    const validIds = new Set(documents.map((d) => d.id));
    return parsed.filter(
      (t) =>
        validIds.has(t.documentAId) &&
        validIds.has(t.documentBId) &&
        t.documentAId !== t.documentBId &&
        t.strength >= 0.3 &&
        t.strength <= 1.0
    );
  } catch {
    console.error('[ThemeAnalysis] Failed to parse Claude response');
    return [];
  }
}

async function findConnectionsForDocument(
  newDoc: { id: string; projectName: string; title: string; excerpt: string },
  existingDocs: Array<{ id: string; projectName: string; title: string; excerpt: string }>
): Promise<DiscoveredTheme[]> {
  const systemPrompt = `You are a literary analyst. A writer has added a new document to their corpus. Identify any thematic connections between this new document and their existing work.

Return your analysis as a JSON array of connections. Each connection should have:
- documentAId: the new document's ID
- documentBId: the existing document's ID
- theme: a short theme label (2-5 words)
- explanation: a 1-2 sentence explanation of the connection
- strength: a score from 0.1 to 1.0 indicating connection strength

Only include meaningful connections (strength >= 0.4). Return at most 5 connections.
Return ONLY the JSON array, no other text. If no connections found, return [].`;

  const userMessage = `NEW DOCUMENT:\n[ID: ${newDoc.id}]\nProject: ${newDoc.projectName}\nTitle: ${newDoc.title}\nExcerpt:\n${newDoc.excerpt}\n\n---\n\nEXISTING DOCUMENTS:\n${existingDocs
    .map((d) => `[ID: ${d.id}]\nProject: ${d.projectName}\nTitle: ${d.title}\nExcerpt:\n${d.excerpt}\n---`)
    .join('\n\n')}`;

  const response = await sendMessage({
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    model: 'sonnet', // Use Sonnet for single-document checks (faster)
  });

  try {
    const parsed = JSON.parse(response.content) as DiscoveredTheme[];
    const validExistingIds = new Set(existingDocs.map((d) => d.id));
    return parsed.filter(
      (t) =>
        t.documentAId === newDoc.id &&
        validExistingIds.has(t.documentBId) &&
        t.strength >= 0.4 &&
        t.strength <= 1.0
    );
  } catch {
    console.error('[ThemeAnalysis] Failed to parse Claude response for document check');
    return [];
  }
}
