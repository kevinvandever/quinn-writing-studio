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
  /** Documents and folders whose title changed. (Absent in imports before Nov 2026.) */
  renamed?: Array<{ uuid: string; oldTitle: string; newTitle: string }>;
  /** Documents and folders that moved to a different folder, with binder paths. */
  moved?: Array<{ uuid: string; title: string; from: string; to: string }>;
  /** Folders (or the binder's top level) whose items were put in a new order. */
  reordered?: Array<{ uuid: string | null; title: string }>;
}

/** What the database knows about a document, for change detection. */
export interface ExistingDocumentInfo {
  source_id: string;
  title: string;
  content_hash: string;
  word_count: number;
  /** Scrivener UUID of the parent (null at the top level); omit if unknown. */
  parent_source_id?: string | null;
  sort_order?: number | null;
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
 * Detect changes between a new parse result and existing stored documents:
 * text added, changed, or deleted, and, when the existing documents carry
 * their binder position, renames, moves, and reordering.
 */
export function detectChanges(
  newDocuments: ParsedDocument[],
  existingDocuments: ExistingDocumentInfo[]
): DiffSummary {
  const summary = detectContentChanges(newDocuments, existingDocuments);
  if (existingDocuments.every((d) => d.parent_source_id !== undefined)) {
    Object.assign(summary, detectStructureChanges(newDocuments, existingDocuments));
  }
  return summary;
}

/** Renames, moves between folders, and new orders within a folder. */
function detectStructureChanges(
  newDocuments: ParsedDocument[],
  existingDocuments: ExistingDocumentInfo[]
): Required<Pick<DiffSummary, 'renamed' | 'moved' | 'reordered'>> {
  interface Place {
    title: string;
    parent: string | null;
    order: number;
  }
  const now = new Map<string, Place>();
  const walk = (docs: ParsedDocument[], parent: string | null): void => {
    docs.forEach((d, i) => {
      if (!now.has(d.uuid)) now.set(d.uuid, { title: d.title, parent, order: d.sortOrder ?? i });
      walk(d.children, d.uuid);
    });
  };
  walk(newDocuments, null);
  const before = new Map<string, Place>();
  for (const d of existingDocuments) {
    if (!before.has(d.source_id)) {
      before.set(d.source_id, { title: d.title, parent: d.parent_source_id ?? null, order: d.sort_order ?? 0 });
    }
  }
  const pathOf = (places: Map<string, Place>, parent: string | null): string => {
    const names: string[] = [];
    for (let p = parent, guard = 0; p && guard < 50; guard++) {
      const place = places.get(p);
      if (!place) break;
      names.unshift(place.title);
      p = place.parent;
    }
    return names.length > 0 ? names.join(' › ') : 'the top level of the binder';
  };

  const renamed: DiffSummary['renamed'] = [];
  const moved: DiffSummary['moved'] = [];
  for (const [uuid, place] of now) {
    const old = before.get(uuid);
    if (!old) continue;
    if (old.title !== place.title) renamed!.push({ uuid, oldTitle: old.title, newTitle: place.title });
    if (old.parent !== place.parent) {
      moved!.push({ uuid, title: place.title, from: pathOf(before, old.parent), to: pathOf(now, place.parent) });
    }
  }

  // A folder is reordered when the items that stayed in it changed order.
  // (Positions also shift when items are added or moved; that isn't a reorder.)
  const childrenIn = (places: Map<string, Place>): Map<string | null, string[]> => {
    const groups = new Map<string | null, Array<[string, number]>>();
    for (const [uuid, place] of places) {
      const list = groups.get(place.parent) ?? [];
      list.push([uuid, place.order]);
      groups.set(place.parent, list);
    }
    const ordered = new Map<string | null, string[]>();
    for (const [parent, list] of groups) {
      ordered.set(parent, list.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([u]) => u));
    }
    return ordered;
  };
  const oldChildren = childrenIn(before);
  const reordered: DiffSummary['reordered'] = [];
  for (const [parent, kids] of childrenIn(now)) {
    const stayed = new Set(kids.filter((u) => before.get(u)?.parent === parent));
    const oldOrder = (oldChildren.get(parent) ?? []).filter((u) => stayed.has(u));
    const newOrder = kids.filter((u) => stayed.has(u));
    if (oldOrder.join('|') !== newOrder.join('|')) {
      reordered!.push({ uuid: parent, title: parent ? now.get(parent)?.title ?? 'a folder' : 'the top level of the binder' });
    }
  }
  return { renamed, moved, reordered };
}

function detectContentChanges(
  newDocuments: ParsedDocument[],
  existingDocuments: ExistingDocumentInfo[]
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
