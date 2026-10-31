/**
 * Manuscript Context Service
 *
 * Loads the writer's manuscript as full text for the cached part of Quinn's
 * prompt. With a 1M-token context window and prompt caching, Quinn can have
 * read every word of the book on every turn for a few cents, instead of seeing
 * the first 3,000 characters of whichever pieces a keyword search happened to hit.
 *
 * "The book" is Scrivener's Draft folder plus top-level Front Matter and Back
 * Matter folders. Everything else outside Trash (salvage, notes, research) is
 * "outside material": included in full only for modes that work across the
 * whole corpus (/analyze, essay triage), otherwise reached through retrieval.
 *
 * Output must be byte-identical between turns when nothing changed, or the
 * prompt cache misses. Ordering is fully deterministic and numbers are
 * formatted with a fixed locale.
 */
import { query } from '../db/connection.js';

/** Rough ceilings so an unexpectedly huge binder can't blow the budget. */
const BOOK_CHAR_CAP = 600_000; // about 200k tokens
const OUTSIDE_CHAR_CAP = 400_000; // about 130k tokens

export interface ManuscriptContext {
  /** Rendered book section, or null when the project has no Scrivener Draft folder. */
  bookText: string | null;
  /** Rendered outside-material section; null unless requested and non-empty. */
  outsideText: string | null;
  /** Documents included in full in bookText. */
  bookIds: Set<string>;
  /** Documents included in full in outsideText. */
  outsideIds: Set<string>;
}

interface Node {
  id: string;
  title: string;
  content: string;
  wordCount: number;
  isFolder: boolean;
  scrivenerType: string | null;
  sortOrder: number;
  children: Node[];
}

type RootKind = 'book' | 'trash' | 'outside';

function rootKind(node: Node): RootKind {
  const title = node.title.trim().toLowerCase();
  if (node.scrivenerType === 'TrashFolder' || (node.isFolder && title === 'trash')) return 'trash';
  if (node.scrivenerType === 'DraftFolder') return 'book';
  if (node.isFolder && (title === 'front matter' || title === 'back matter')) return 'book';
  return 'outside';
}

const formatNumber = (n: number): string => n.toLocaleString('en-US');

/**
 * Render the documents under `roots` as <piece> blocks in binder order, up to
 * `cap` characters. Returns the rendered pieces, the ids included, and the
 * titles that didn't fit.
 */
function renderPieces(
  roots: Node[],
  cap: number
): { text: string; ids: Set<string>; skipped: string[] } {
  const parts: string[] = [];
  const ids = new Set<string>();
  const skipped: string[] = [];
  let used = 0;

  const walk = (nodes: Node[], path: string[]): void => {
    for (const node of nodes) {
      if (!node.isFolder && node.content.trim() !== '') {
        const block = [
          '<piece>',
          `Title: ${node.title}`,
          `Location: ${path.join(' › ')}`,
          `Words: ${formatNumber(node.wordCount)}`,
          '',
          node.content.trim(),
          '</piece>',
        ].join('\n');
        if (used + block.length <= cap) {
          parts.push(block);
          ids.add(node.id);
          used += block.length + 2;
        } else {
          skipped.push(node.title);
        }
      }
      if (node.children.length > 0) walk(node.children, [...path, node.title]);
    }
  };

  for (const root of roots) {
    // A root document (rare) sits directly in the binder; a root folder names the path.
    if (root.isFolder) {
      walk(root.children, [root.title]);
    } else {
      walk([root], []);
    }
  }

  return { text: parts.join('\n\n'), ids, skipped };
}

/**
 * Load the project's book (and optionally the outside material) as full text.
 */
export async function loadManuscriptContext(
  projectId: string,
  options: { includeOutside: boolean }
): Promise<ManuscriptContext> {
  const result = await query<{
    id: string;
    parent_id: string | null;
    title: string | null;
    content: string | null;
    word_count: number | null;
    is_folder: boolean;
    sort_order: number | null;
    scrivener_type: string | null;
  }>(
    `SELECT id, parent_id, title, content, word_count, is_folder, sort_order,
            metadata->>'scrivenerType' AS scrivener_type
     FROM corpus_documents
     WHERE project_id = $1 AND source_type = 'scrivener'`,
    [projectId]
  );

  const empty: ManuscriptContext = {
    bookText: null,
    outsideText: null,
    bookIds: new Set(),
    outsideIds: new Set(),
  };
  if (result.rows.length === 0) return empty;

  const nodes = new Map<string, Node>();
  for (const row of result.rows) {
    nodes.set(row.id, {
      id: row.id,
      title: (row.title || 'Untitled').trim(),
      content: row.content ?? '',
      wordCount: row.word_count ?? 0,
      isFolder: row.is_folder,
      scrivenerType: row.scrivener_type,
      sortOrder: row.sort_order ?? 0,
      children: [],
    });
  }
  const roots: Node[] = [];
  for (const row of result.rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Deterministic order: binder position, then title, then id.
  const sortTree = (list: Node[]): void => {
    list.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.title.localeCompare(b.title, 'en') ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    for (const n of list) sortTree(n.children);
  };
  sortTree(roots);

  const bookRoots = roots.filter((r) => rootKind(r) === 'book');
  if (!bookRoots.some((r) => r.scrivenerType === 'DraftFolder')) return empty;

  const book = renderPieces(bookRoots, BOOK_CHAR_CAP);
  const bookWords = [...book.ids].reduce((sum, id) => sum + (nodes.get(id)?.wordCount ?? 0), 0);
  const bookText = [
    '## The Manuscript (full text)',
    `Below is the complete text of every piece in the writer's live manuscript (Scrivener's Draft folder, plus front and back matter) as of the latest sync, in binder order: ${formatNumber(book.ids.size)} pieces, ${formatNumber(bookWords)} words. You have read all of it. Refer to specific pieces, scenes, and lines directly, and don't ask the writer to paste something that's already here. Quote only to point at a passage, never to rewrite it. The binder map, with a logline for each piece, comes after this.`,
    book.skipped.length > 0
      ? `${book.skipped.length} piece${book.skipped.length === 1 ? '' : 's'} didn't fit and aren't included in full (their loglines are in the map): ${book.skipped.join('; ')}.`
      : '',
    '<manuscript>',
    book.text,
    '</manuscript>',
  ]
    .filter(Boolean)
    .join('\n\n');

  let outsideText: string | null = null;
  let outsideIds = new Set<string>();
  if (options.includeOutside) {
    const outsideRoots = roots.filter((r) => rootKind(r) === 'outside');
    const outside = renderPieces(outsideRoots, OUTSIDE_CHAR_CAP);
    if (outside.ids.size > 0) {
      outsideIds = outside.ids;
      outsideText = [
        '## Material Outside the Manuscript (full text)',
        "For this mode you also have everything else in the binder outside Trash: salvage, notes, and research. None of it is in the book yet. Look for material worth bringing in, and say where it lives.",
        outside.skipped.length > 0
          ? `${outside.skipped.length} piece${outside.skipped.length === 1 ? '' : 's'} didn't fit and aren't included: ${outside.skipped.join('; ')}.`
          : '',
        '<outside_material>',
        outside.text,
        '</outside_material>',
      ]
        .filter(Boolean)
        .join('\n\n');
    }
  }

  return { bookText, outsideText, bookIds: book.ids, outsideIds };
}
