/**
 * Scrivener Directory Parser Service
 *
 * Reads a .scriv package directly from the filesystem (no ZIP required).
 * Extracts document tree from the .scrivx XML binder,
 * reads RTF content files, strips formatting, and computes metadata.
 *
 * This is the filesystem equivalent of scrivener-parser.service.ts,
 * used by the local watcher agent for automatic corpus sync.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';
import { stripRtf } from '../utils/rtf-parser.js';
import type { ParsedDocument, ScrivenerParseResult } from './scrivener-parser.service.js';

interface BinderItem {
  '@_UUID': string;
  '@_Type': string;
  Title?: string;
  Children?: { BinderItem: BinderItem | BinderItem[] };
}

/**
 * Parse a .scriv package directory directly from the filesystem.
 */
export function parseScrivenerDirectory(scrivPath: string): ScrivenerParseResult {
  if (!existsSync(scrivPath)) {
    throw new Error(`Scrivener project not found: ${scrivPath}`);
  }

  // Find the .scrivx binder file inside the package
  const entries = readdirSync(scrivPath);
  const scrivxFile = entries.find((f) => f.endsWith('.scrivx'));

  if (!scrivxFile) {
    throw new Error('Invalid .scriv package: no .scrivx binder file found');
  }

  // Parse the XML binder
  const scrivxContent = readFileSync(join(scrivPath, scrivxFile), 'utf-8');
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

  const dataDir = join(scrivPath, 'Files', 'Data');
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

      let content = '';
      let wordCount = 0;
      let contentHash = '';

      if (!isFolder) {
        // Read content.rtf from Files/Data/{UUID}/
        const rtfPath = join(dataDir, uuid, 'content.rtf');

        if (existsSync(rtfPath)) {
          try {
            const rtfContent = readFileSync(rtfPath, 'utf-8');
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
  const filename = basename(scrivPath);

  return {
    documents,
    totalWordCount,
    documentCount,
    parseErrors,
    filename,
  };
}

function computeWordCount(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }
  return text.trim().split(/\s+/).length;
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sumWordCounts(documents: ParsedDocument[]): number {
  return documents.reduce((sum, doc) => sum + doc.wordCount, 0);
}
