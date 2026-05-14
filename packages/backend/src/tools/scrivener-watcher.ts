#!/usr/bin/env tsx
/**
 * Scrivener Watcher — Local Agent
 *
 * Watches a .scriv package directory for file changes using macOS FSEvents.
 * When changes are detected (debounced), parses the project and uploads
 * the corpus to the Quinn Writing Studio backend.
 *
 * Usage:
 *   npm run scriv:watch -w @quinn/backend
 *
 * Environment variables (or .env file):
 *   SCRIV_PATH       — Path to the .scriv package (required)
 *   SCRIV_PROJECT_ID — Quinn project ID to sync to (required)
 *   QUINN_API_URL    — Backend API URL (default: https://your-railway-url)
 *   QUINN_EMAIL      — Login email for auth
 *   QUINN_PASSWORD   — Login password for auth
 *
 * The watcher:
 *   1. Authenticates with the backend to get a JWT
 *   2. Watches the .scriv directory for filesystem changes
 *   3. On change (debounced 5s), parses the .scriv package
 *   4. Computes a content hash of the full corpus
 *   5. If the hash differs from last sync, uploads via the corpus API
 */

import 'dotenv/config';
import { watch, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { parseScrivenerDirectory } from '../services/scrivener-directory-parser.service.js';
import { flattenDocuments } from '../services/scrivener-parser.service.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const SCRIV_PATH = process.env.SCRIV_PATH;
const PROJECT_ID = process.env.SCRIV_PROJECT_ID;
const API_URL = process.env.QUINN_API_URL || 'http://localhost:3001';
const EMAIL = process.env.QUINN_EMAIL;
const PASSWORD = process.env.QUINN_PASSWORD;
const DEBOUNCE_MS = parseInt(process.env.SCRIV_DEBOUNCE_MS || '5000', 10);
const STATE_FILE = join(process.cwd(), '.scriv-watcher-state.json');

if (!SCRIV_PATH || !PROJECT_ID || !EMAIL || !PASSWORD) {
  console.error(`
Scrivener Watcher — Missing required configuration.

Required environment variables:
  SCRIV_PATH         Path to your .scriv package
  SCRIV_PROJECT_ID   Quinn project ID to sync to
  QUINN_EMAIL        Your login email
  QUINN_PASSWORD     Your login password

Optional:
  QUINN_API_URL      Backend URL (default: http://localhost:3001)
  SCRIV_DEBOUNCE_MS  Debounce delay in ms (default: 5000)

Example:
  SCRIV_PATH="/Users/kevin/Dropbox/EssayCollection.scriv" \\
  SCRIV_PROJECT_ID="a4509dae-b732-4a9f-9aa0-af4958c14cee" \\
  QUINN_API_URL="https://your-app.railway.app" \\
  QUINN_EMAIL="kevin.vandever@mac.com" \\
  QUINN_PASSWORD="yourpassword" \\
  npm run scriv:watch -w @quinn/backend
`);
  process.exit(1);
}

if (!existsSync(SCRIV_PATH)) {
  console.error(`Error: Scrivener project not found at: ${SCRIV_PATH}`);
  process.exit(1);
}

// ─── State Management ────────────────────────────────────────────────────────

interface WatcherState {
  lastCorpusHash: string;
  lastSyncAt: string;
}

function loadState(): WatcherState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as WatcherState;
    }
  } catch {
    // Corrupted state file, start fresh
  }
  return null;
}

function saveState(state: WatcherState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Auth ────────────────────────────────────────────────────────────────────

let authToken: string | null = null;

async function authenticate(): Promise<string> {
  console.log('[Auth] Logging in...');
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Authentication failed (${response.status}): ${body}`);
  }

  const data = await response.json() as { token: string };
  console.log('[Auth] Authenticated successfully.');
  return data.token;
}

async function getToken(): Promise<string> {
  if (!authToken) {
    authToken = await authenticate();
  }
  return authToken;
}

// ─── Sync Logic ──────────────────────────────────────────────────────────────

function computeCorpusHash(documents: ReturnType<typeof flattenDocuments>): string {
  const hashInput = documents
    .filter((d) => !d.isFolder)
    .map((d) => `${d.uuid}:${d.contentHash}`)
    .sort()
    .join('|');
  return createHash('sha256').update(hashInput).digest('hex');
}

async function syncCorpus(): Promise<void> {
  console.log(`[Sync] Parsing ${SCRIV_PATH}...`);

  const parseResult = parseScrivenerDirectory(SCRIV_PATH!);
  const flatDocs = flattenDocuments(parseResult.documents);
  const corpusHash = computeCorpusHash(flatDocs);

  // Check if anything actually changed
  const state = loadState();
  if (state && state.lastCorpusHash === corpusHash) {
    console.log('[Sync] No content changes detected (hash unchanged). Skipping upload.');
    return;
  }

  console.log(`[Sync] Changes detected. ${parseResult.documentCount} documents, ${parseResult.totalWordCount} words.`);

  if (parseResult.parseErrors.length > 0) {
    console.warn(`[Sync] Parse warnings: ${parseResult.parseErrors.length}`);
    for (const err of parseResult.parseErrors) {
      console.warn(`  - ${err.documentName}: ${err.error}`);
    }
  }

  // Upload as a ZIP to the existing endpoint (reuse existing infrastructure)
  // We'll create an in-memory ZIP from the parsed data and POST it
  const token = await getToken();

  // Use the parsed data directly via a new JSON endpoint
  const response = await fetch(`${API_URL}/api/projects/${PROJECT_ID}/corpus/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      filename: parseResult.filename,
      documents: parseResult.documents,
      totalWordCount: parseResult.totalWordCount,
      documentCount: parseResult.documentCount,
      parseErrors: parseResult.parseErrors,
    }),
  });

  if (response.status === 401) {
    // Token expired, re-auth and retry
    console.log('[Sync] Token expired, re-authenticating...');
    authToken = await authenticate();
    const retryResponse = await fetch(`${API_URL}/api/projects/${PROJECT_ID}/corpus/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        filename: parseResult.filename,
        documents: parseResult.documents,
        totalWordCount: parseResult.totalWordCount,
        documentCount: parseResult.documentCount,
        parseErrors: parseResult.parseErrors,
      }),
    });

    if (!retryResponse.ok) {
      const body = await retryResponse.text();
      throw new Error(`Sync failed after re-auth (${retryResponse.status}): ${body}`);
    }

    const result = await retryResponse.json();
    console.log('[Sync] Upload complete:', JSON.stringify(result, null, 2));
  } else if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sync failed (${response.status}): ${body}`);
  } else {
    const result = await response.json() as { import?: { diffSummary?: { added?: unknown[]; modified?: unknown[]; deleted?: unknown[] } } };
    console.log('[Sync] Upload complete.');
    if (result.import) {
      const diff = result.import.diffSummary;
      if (diff) {
        console.log(`  Added: ${diff.added?.length || 0}, Modified: ${diff.modified?.length || 0}, Deleted: ${diff.deleted?.length || 0}`);
      }
    }
  }

  // Save state
  saveState({
    lastCorpusHash: corpusHash,
    lastSyncAt: new Date().toISOString(),
  });
}

// ─── File Watcher ────────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;

function onFileChange(): void {
  if (syncing) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(async () => {
    syncing = true;
    try {
      await syncCorpus();
    } catch (err) {
      console.error('[Sync] Error:', err instanceof Error ? err.message : err);
    } finally {
      syncing = false;
    }
  }, DEBOUNCE_MS);
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════════════╗
║         Scrivener Watcher — Quinn Writing Studio        ║
╠══════════════════════════════════════════════════════════╣
║  Watching: ${SCRIV_PATH.slice(-46).padEnd(46)}║
║  Project:  ${PROJECT_ID.padEnd(46)}║
║  API:      ${API_URL.slice(-46).padEnd(46)}║
║  Debounce: ${(DEBOUNCE_MS + 'ms').padEnd(46)}║
╚══════════════════════════════════════════════════════════╝
`);

// Do an initial sync on startup
console.log('[Watcher] Running initial sync...');
syncCorpus()
  .then(() => {
    console.log('[Watcher] Initial sync complete. Watching for changes...\n');
  })
  .catch((err) => {
    console.error('[Watcher] Initial sync failed:', err instanceof Error ? err.message : err);
    console.log('[Watcher] Will retry on next file change.\n');
  });

// Watch the .scriv directory recursively
watch(SCRIV_PATH, { recursive: true }, (_eventType, filename) => {
  // Ignore .DS_Store and other system files
  if (filename && (filename.includes('.DS_Store') || filename.startsWith('.'))) {
    return;
  }
  onFileChange();
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Watcher] Shutting down...');
  if (debounceTimer) clearTimeout(debounceTimer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Watcher] Shutting down...');
  if (debounceTimer) clearTimeout(debounceTimer);
  process.exit(0);
});
