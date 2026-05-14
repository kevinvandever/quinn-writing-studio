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

export interface ParsedDocument {
  uuid: string;
  title: string;
  content: string;
  wordCount: number;
  contentHash: string;
  isFolder: boolean;
  sortOrder: number;
  children: ParsedDocument[];
}

export interface ScrivenerParseResult {
  documents: ParsedDocument[];
  totalWordCount: number;
  documentCount: number;
  parseErrors: Array<{ documentName: string; error: string }>;
  filename: string;
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

  return {
    documents,
    totalWordCount,
    documentCount,
    parseErrors,
    filename,
  };
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
