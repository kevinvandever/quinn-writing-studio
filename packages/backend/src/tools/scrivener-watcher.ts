#!/usr/bin/env tsx
/**
 * Scrivener Watcher — Local Agent
 *
 * Watches the Scrivener automatic backup folder for new ZIP files.
 * When a new backup appears (triggered by closing a project in Scrivener),
 * it finds the most recent backup matching the configured project name,
 * parses it using the existing ZIP parser, and syncs to the Quinn backend.
 *
 * Usage:
 *   npm run scriv:watch -w @quinn/backend
 *
 * Environment variables (or .env file):
 *   SCRIV_BACKUP_DIR  — Path to Scrivener's backup folder (required)
 *   SCRIV_PROJECT_NAME — Name prefix to match in backup filenames (required)
 *   SCRIV_PROJECT_ID  — Quinn project ID to sync to (required)
 *   QUINN_API_URL     — Backend API URL (required)
 *   QUINN_EMAIL       — Login email for auth (required)
 *   QUINN_PASSWORD    — Login password for auth (required)
 *
 * The watcher:
 *   1. Authenticates with the backend to get a JWT
 *   2. Watches the backup folder for new/changed files
 *   3. On change (debounced 5s), finds the most recent matching backup ZIP
 *   4. Parses it using the existing Scrivener ZIP parser
 *   5. If content hash differs from last sync, uploads via the corpus API
 */

import 'dotenv/config';
import { watch, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { parseScrivenerZip, flattenDocuments } from '../services/scrivener-parser.service.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const BACKUP_DIR = process.env.SCRIV_BACKUP_DIR;
const PROJECT_NAME = process.env.SCRIV_PROJECT_NAME;
const PROJECT_ID = process.env.SCRIV_PROJECT_ID;
const API_URL = process.env.QUINN_API_URL || 'http://localhost:3001';
const EMAIL = process.env.QUINN_EMAIL;
const PASSWORD = process.env.QUINN_PASSWORD;
const DEBOUNCE_MS = parseInt(process.env.SCRIV_DEBOUNCE_MS || '5000', 10);
const STATE_FILE = join(process.cwd(), '.scriv-watcher-state.json');

if (!BACKUP_DIR || !PROJECT_NAME || !PROJECT_ID || !EMAIL || !PASSWORD) {
  console.error(`
Scrivener Watcher — Missing required configuration.

Required environment variables:
  SCRIV_BACKUP_DIR    Path to Scrivener's backup folder
  SCRIV_PROJECT_NAME  Project name prefix to match in backup filenames
  SCRIV_PROJECT_ID    Quinn project ID to sync to
  QUINN_API_URL       Backend URL
  QUINN_EMAIL         Your login email
  QUINN_PASSWORD      Your login password

Optional:
  SCRIV_DEBOUNCE_MS   Debounce delay in ms (default: 5000)

Example .env:
  SCRIV_BACKUP_DIR="/Users/kevinvandever/Library/Application Support/Scrivener/Backups"
  SCRIV_PROJECT_NAME="Essay Collection"
  SCRIV_PROJECT_ID="a4509dae-b732-4a9f-9aa0-af4958c14cee"
  QUINN_API_URL="https://your-app.railway.app"
  QUINN_EMAIL="kevin.vandever@mac.com"
  QUINN_PASSWORD="yourpassword"
`);
  process.exit(1);
}

if (!existsSync(BACKUP_DIR)) {
  console.error(`Error: Backup directory not found at: ${BACKUP_DIR}`);
  process.exit(1);
}

// ─── State Management ────────────────────────────────────────────────────────

interface WatcherState {
  lastCorpusHash: string;
  lastSyncAt: string;
  lastBackupFile: string;
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

// ─── Backup File Discovery ───────────────────────────────────────────────────

/**
 * Find the most recent backup ZIP matching the project name.
 * Scrivener names backups like "Essay Collection.zip" or
 * "Essay Collection 2024-01-15.zip" depending on settings.
 */
function findLatestBackup(): { path: string; mtime: Date } | null {
  const files = readdirSync(BACKUP_DIR!);
  const matchingZips = files
    .filter((f) => f.toLowerCase().includes(PROJECT_NAME!.toLowerCase()) && f.endsWith('.zip'))
    .map((f) => {
      const fullPath = join(BACKUP_DIR!, f);
      const stat = statSync(fullPath);
      return { path: fullPath, filename: f, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (matchingZips.length === 0) {
    return null;
  }

  return matchingZips[0]!;
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
  const backup = findLatestBackup();
  if (!backup) {
    console.log(`[Sync] No backup ZIPs found matching "${PROJECT_NAME}" in ${BACKUP_DIR}`);
    return;
  }

  console.log(`[Sync] Found backup: ${backup.path}`);
  console.log(`[Sync] Modified: ${backup.mtime.toLocaleString()}`);

  // Read and parse the ZIP
  const zipBuffer = readFileSync(backup.path);
  const parseResult = parseScrivenerZip(zipBuffer, backup.path);
  const flatDocs = flattenDocuments(parseResult.documents);
  const corpusHash = computeCorpusHash(flatDocs);

  // Check if anything actually changed
  const state = loadState();
  if (state && state.lastCorpusHash === corpusHash) {
    console.log('[Sync] No content changes since last sync. Skipping upload.');
    return;
  }

  console.log(`[Sync] Changes detected. ${parseResult.documentCount} documents, ${parseResult.totalWordCount} words.`);

  if (parseResult.parseErrors.length > 0) {
    console.warn(`[Sync] Parse warnings: ${parseResult.parseErrors.length}`);
    for (const err of parseResult.parseErrors) {
      console.warn(`  - ${err.documentName}: ${err.error}`);
    }
  }

  // Upload via the sync endpoint
  const token = await getToken();

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
  } else if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sync failed (${response.status}): ${body}`);
  }

  const result = await response.json() as { import?: { diffSummary?: { added?: unknown[]; modified?: unknown[]; deleted?: unknown[] } } };
  console.log('[Sync] Upload complete.');
  if (result.import) {
    const diff = result.import.diffSummary;
    if (diff) {
      console.log(`  Added: ${diff.added?.length || 0}, Modified: ${diff.modified?.length || 0}, Deleted: ${diff.deleted?.length || 0}`);
    }
  }

  // Save state
  saveState({
    lastCorpusHash: corpusHash,
    lastSyncAt: new Date().toISOString(),
    lastBackupFile: backup.path,
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
║  Backup dir: ${(BACKUP_DIR ?? '').slice(-43).padEnd(43)}║
║  Project:    ${(PROJECT_NAME ?? '').padEnd(43)}║
║  API:        ${API_URL.slice(-43).padEnd(43)}║
║  Debounce:   ${(DEBOUNCE_MS + 'ms').padEnd(43)}║
╚══════════════════════════════════════════════════════════╝
`);

// Do an initial sync on startup
console.log('[Watcher] Running initial sync...');
syncCorpus()
  .then(() => {
    console.log('[Watcher] Initial sync complete. Watching for new backups...\n');
  })
  .catch((err) => {
    console.error('[Watcher] Initial sync failed:', err instanceof Error ? err.message : err);
    console.log('[Watcher] Will retry when a new backup appears.\n');
  });

// Watch the backup directory for new files
watch(BACKUP_DIR, (_eventType, filename) => {
  // Only react to ZIP files matching our project
  if (filename && filename.endsWith('.zip') && filename.toLowerCase().includes(PROJECT_NAME!.toLowerCase())) {
    console.log(`[Watcher] New backup detected: ${filename}`);
    onFileChange();
  }
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
