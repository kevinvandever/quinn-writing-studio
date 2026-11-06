/**
 * Scrivener Parser Service
 *
 * Parses .scriv ZIP bundles uploaded as ZIP files.
 * Extracts document tree from the .scrivx XML binder,
 * reads RTF content files, strips formatting, and computes metadata.
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';
import { stripRtf } from '../utils/rtf-parser.js';
import { comparableText } from '../utils/paragraph-diff.js';

export interface ParsedDocument {
  uuid: string;
  title: string;
  content: string;
  wordCount: number;
  contentHash: string;
  isFolder: boolean;
  /**
   * Raw Scrivener binder item type (e.g. 'Text', 'Folder', 'DraftFolder',
   * 'ResearchFolder', 'TrashFolder'). Preserved so the coach can distinguish
   * the live manuscript from research notes and trash.
   */
  scrivenerType: string;
  sortOrder: number;
  children: ParsedDocument[];
}

/** One Scrivener snapshot: a version of a document the writer (or Scrivener) saved. */
export interface ParsedSnapshot {
  /** Binder UUID of the document. */
  uuid: string;
  /** When it was taken, as an ISO timestamp (UTC). */
  takenAt: string;
  /** Scrivener's snapshot title, e.g. "Untitled Snapshot" or "Published". */
  title: string;
  content: string;
  wordCount: number;
  contentHash: string;
}

export interface ScrivenerParseResult {
  documents: ParsedDocument[];
  totalWordCount: number;
  documentCount: number;
  parseErrors: Array<{ documentName: string; error: string }>;
  filename: string;
  /** Snapshots of documents outside Trash, oldest first, without repeats. */
  snapshots?: ParsedSnapshot[];
}

export interface DiffSummary {
  added: Array<{ title: string; uuid: string }>;
  modified: Array<{ title: string; uuid: string; oldWordCount: number; newWordCount: number }>;
  deleted: Array<{ title: string; uuid: string }>;
}

interface BinderItem {
  '@_UUID': string;
  '@_Type': string;
  Title?: string;
  Children?: { BinderItem: BinderItem | BinderItem[] };
}

/**
 * Parse a .scriv ZIP bundle and extract the document tree.
 */
export function parseScrivenerZip(zipBuffer: Buffer, filename: string): ScrivenerParseResult {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Locate the .scrivx binder file
  const scrivxEntry = entries.find((entry) => entry.entryName.endsWith('.scrivx'));

  if (!scrivxEntry) {
    throw new Error('Invalid .scriv package: no .scrivx binder file found');
  }

  // Parse the XML binder
  const scrivxContent = scrivxEntry.getData().toString('utf-8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'BinderItem',
  });

  const parsed = parser.parse(scrivxContent);

  // Navigate to the binder items
  const binder = parsed?.ScrivenerProject?.Binder;
  if (!binder) {
    throw new Error('Invalid .scrivx file: no Binder element found');
  }

  // Find the root path prefix (the .scriv directory name inside the ZIP)
  const scrivxPath = scrivxEntry.entryName;
  const rootPrefix = scrivxPath.includes('/')
    ? scrivxPath.substring(0, scrivxPath.lastIndexOf('/') + 1)
    : '';

  const parseErrors: Array<{ documentName: string; error: string }> = [];
  let totalWordCount = 0;
  let documentCount = 0;

  /**
   * Recursively process binder items to build the document tree.
   */
  function processBinderItems(items: BinderItem[], sortStart: number = 0): ParsedDocument[] {
    const documents: ParsedDocument[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const uuid = item['@_UUID'];
      const type = item['@_Type'];
      const title = item.Title || 'Untitled';
      const isFolder = type === 'Folder' || type === 'DraftFolder' || type === 'ResearchFolder' || type === 'TrashFolder';

      // Try to read the content.rtf file for this document
      let content = '';
      let wordCount = 0;
      let contentHash = '';

      if (!isFolder) {
        // Look for content.rtf in Files/Data/{UUID}/
        const rtfPath = `${rootPrefix}Files/Data/${uuid}/content.rtf`;
        const rtfEntry = zip.getEntry(rtfPath);

        if (rtfEntry) {
          try {
            const rtfContent = rtfEntry.getData().toString('utf-8');
            content = stripRtf(rtfContent);
            wordCount = computeWordCount(content);
            contentHash = computeHash(content);
            totalWordCount += wordCount;
            documentCount++;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            parseErrors.push({ documentName: title, error: errorMessage });
            contentHash = computeHash('');
          }
        } else {
          // No content file — empty document
          contentHash = computeHash('');
          documentCount++;
        }
      } else {
        contentHash = computeHash('');
      }

      // Process children recursively
      let children: ParsedDocument[] = [];
      if (item.Children?.BinderItem) {
        const childItems = Array.isArray(item.Children.BinderItem)
          ? item.Children.BinderItem
          : [item.Children.BinderItem];
        children = processBinderItems(childItems);
      }

      // For folders, aggregate word count from children
      if (isFolder) {
        wordCount = sumWordCounts(children);
      }

      documents.push({
        uuid,
        title,
        content,
        wordCount,
        contentHash,
        isFolder,
        scrivenerType: type,
        sortOrder: sortStart + i,
        children,
      });
    }

    return documents;
  }

  // Get the root binder items
  let binderItems: BinderItem[] = [];
  if (binder.BinderItem) {
    binderItems = Array.isArray(binder.BinderItem)
      ? binder.BinderItem
      : [binder.BinderItem];
  }

  const documents = processBinderItems(binderItems);

  // Snapshots are kept for documents outside Trash only.
  const liveUuids = new Set<string>();
  const collectLive = (docs: ParsedDocument[]): void => {
    for (const d of docs) {
      if (d.scrivenerType === 'TrashFolder') continue;
      if (!d.isFolder) liveUuids.add(d.uuid);
      collectLive(d.children);
    }
  };
  collectLive(documents);
  const snapshots = parseSnapshots(zip, rootPrefix, liveUuids, parseErrors);

  return {
    documents,
    totalWordCount,
    documentCount,
    parseErrors,
    filename,
    snapshots,
  };
}

/** "2025-09-01 22:40:54 +0100" (index.xml) or "2025-09-01-17-40-54-0400" (file name) → epoch ms. */
function parseSnapshotTime(value: string): number | null {
  const m = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ -](\d{2})[:-](\d{2})[:-](\d{2}) ?([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, tzh, tzm] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${tzh}:${tzm}`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read Scrivener's snapshots: Snapshots/<UUID>.snapshots/ holds one RTF per
 * snapshot, named for the time it was taken, and an index.xml with titles.
 * Consecutive snapshots with the same text are kept once. "Same" ignores
 * extraction debris such as comment links, whose ids change between
 * Scrivener's automatic snapshots of an otherwise unchanged document.
 */
function parseSnapshots(
  zip: AdmZip,
  rootPrefix: string,
  liveUuids: Set<string>,
  parseErrors: Array<{ documentName: string; error: string }>
): ParsedSnapshot[] {
  const prefix = `${rootPrefix}Snapshots/`;
  const folders = new Map<string, { index: AdmZip.IZipEntry | null; files: AdmZip.IZipEntry[] }>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
    const m = entry.entryName.slice(prefix.length).match(/^([0-9A-Za-z-]+)\.snapshots\/([^/]+)$/);
    if (!m || !liveUuids.has(m[1]!)) continue;
    const folder = folders.get(m[1]!) ?? { index: null, files: [] };
    if (m[2] === 'index.xml') folder.index = entry;
    else if (m[2]!.endsWith('.rtf')) folder.files.push(entry);
    folders.set(m[1]!, folder);
  }

  // parseTagValue off, so a title like "2" stays a string.
  const xml = new XMLParser({ isArray: (name) => name === 'Snapshot', parseTagValue: false });
  const snapshots: ParsedSnapshot[] = [];
  for (const [uuid, folder] of folders) {
    // Titles by time, from index.xml.
    const titles = new Map<number, string>();
    if (folder.index) {
      try {
        const parsed = xml.parse(folder.index.getData().toString('utf-8'));
        for (const snap of parsed?.Snapshots?.Snapshot ?? []) {
          const time = parseSnapshotTime(String(snap?.Date ?? ''));
          const title = typeof snap?.Title === 'string' ? snap.Title.trim() : '';
          if (time !== null && title) titles.set(time, title);
        }
      } catch {
        // Titles are a nicety; the snapshots themselves still parse.
      }
    }

    const versions: ParsedSnapshot[] = [];
    for (const file of folder.files) {
      const name = file.entryName.slice(file.entryName.lastIndexOf('/') + 1, -'.rtf'.length);
      const time = parseSnapshotTime(name);
      if (time === null) continue;
      try {
        const content = stripRtf(file.getData().toString('utf-8'));
        if (!content.trim()) continue;
        versions.push({
          uuid,
          takenAt: new Date(time).toISOString(),
          title: titles.get(time) ?? 'Untitled Snapshot',
          content,
          wordCount: computeWordCount(content),
          contentHash: computeHash(content),
        });
      } catch (err) {
        parseErrors.push({
          documentName: `snapshot ${name} of ${uuid}`,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    versions.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    let previous: string | null = null;
    for (const v of versions) {
      const comparable = comparableText(v.content);
      if (comparable === previous) continue;
      previous = comparable;
      snapshots.push(v);
    }
  }
  snapshots.sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.uuid.localeCompare(b.uuid));
  return snapshots;
}

/**
 * Compute word count from plain text content.
 */
function computeWordCount(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }
  return text.trim().split(/\s+/).length;
}

/**
 * Compute SHA-256 hash of content for change detection.
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Sum word counts from child documents recursively.
 */
function sumWordCounts(documents: ParsedDocument[]): number {
  return documents.reduce((sum, doc) => {
    return sum + doc.wordCount;
  }, 0);
}

/**
 * Detect changes between a new parse result and existing stored documents.
 */
export function detectChanges(
  newDocuments: ParsedDocument[],
  existingDocuments: Array<{ source_id: string; title: string; content_hash: string; word_count: number }>
): DiffSummary {
  const existingMap = new Map(
    existingDocuments.map((doc) => [doc.source_id, doc])
  );

  const newFlatDocs = flattenDocuments(newDocuments);
  const newUuids = new Set(newFlatDocs.map((d) => d.uuid));

  const added: DiffSummary['added'] = [];
  const modified: DiffSummary['modified'] = [];
  const deleted: DiffSummary['deleted'] = [];

  // Check for added and modified documents
  for (const doc of newFlatDocs) {
    const existing = existingMap.get(doc.uuid);

    if (!existing) {
      added.push({ title: doc.title, uuid: doc.uuid });
    } else if (existing.content_hash !== doc.contentHash) {
      modified.push({
        title: doc.title,
        uuid: doc.uuid,
        oldWordCount: existing.word_count,
        newWordCount: doc.wordCount,
      });
    }
  }

  // Check for deleted documents
  for (const existing of existingDocuments) {
    if (!newUuids.has(existing.source_id)) {
      deleted.push({ title: existing.title, uuid: existing.source_id });
    }
  }

  return { added, modified, deleted };
}

/**
 * Flatten a nested document tree into a flat array.
 */
export function flattenDocuments(documents: ParsedDocument[]): ParsedDocument[] {
  const result: ParsedDocument[] = [];

  function flatten(docs: ParsedDocument[]): void {
    for (const doc of docs) {
      result.push(doc);
      if (doc.children.length > 0) {
        flatten(doc.children);
      }
    }
  }

  flatten(documents);
  return result;
}
