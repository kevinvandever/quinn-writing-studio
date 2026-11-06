/**
 * Piece Index
 *
 * Every document in a project outside Trash, with where it lives in the
 * binder, for naming pieces in notes and finding a piece the writer named.
 */
import { query } from '../db/connection.js';

export interface PieceInfo {
  id: string;
  title: string;
  /** Binder folders above the piece, e.g. "Essay Collection › Part One". */
  location: string;
  /** In Scrivener's Draft folder or top-level front/back matter. */
  inBook: boolean;
  order: number;
}

export interface PieceIndex {
  /** The project has a Scrivener manuscript (Draft folder). */
  hasBook: boolean;
  /** Binder order for Scrivener documents, then other documents by recency. Trash excluded. */
  pieces: PieceInfo[];
  byId: Map<string, PieceInfo>;
}

export async function loadPieceIndex(projectId: string): Promise<PieceIndex> {
  const result = await query<{
    id: string;
    parent_id: string | null;
    title: string | null;
    is_folder: boolean;
    sort_order: number | null;
    source_type: string;
    scrivener_type: string | null;
  }>(
    `SELECT id, parent_id, title, is_folder, sort_order, source_type,
            metadata->>'scrivenerType' AS scrivener_type
     FROM corpus_documents
     WHERE project_id = $1
     ORDER BY updated_at DESC, id`,
    [projectId]
  );

  interface Node {
    id: string;
    title: string;
    isFolder: boolean;
    sortOrder: number;
    scrivenerType: string | null;
    children: Node[];
  }
  const nodes = new Map<string, Node>();
  const scrivenerRows = result.rows.filter((r) => r.source_type === 'scrivener');
  for (const row of scrivenerRows) {
    nodes.set(row.id, {
      id: row.id,
      title: (row.title || 'Untitled').trim(),
      isFolder: row.is_folder,
      sortOrder: row.sort_order ?? 0,
      scrivenerType: row.scrivener_type,
      children: [],
    });
  }
  const roots: Node[] = [];
  for (const row of scrivenerRows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
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

  const pieces: PieceInfo[] = [];
  const isTrash = (n: Node): boolean =>
    n.scrivenerType === 'TrashFolder' || (n.isFolder && n.title.toLowerCase() === 'trash');
  const isBookRoot = (n: Node): boolean =>
    n.scrivenerType === 'DraftFolder' ||
    (n.isFolder && ['front matter', 'back matter'].includes(n.title.toLowerCase()));
  const walk = (list: Node[], path: string[], inBook: boolean): void => {
    for (const node of list) {
      if (isTrash(node)) continue;
      if (!node.isFolder) {
        pieces.push({ id: node.id, title: node.title, location: path.join(' › '), inBook, order: pieces.length });
      }
      walk(node.children, [...path, node.title], inBook);
    }
  };
  for (const root of roots) {
    if (isTrash(root)) continue;
    if (root.isFolder) walk(root.children, [root.title], isBookRoot(root));
    else walk([root], [], false);
  }
  const hasBook = roots.some((r) => r.scrivenerType === 'DraftFolder');

  // Substack posts and other non-Scrivener documents, most recent first.
  for (const row of result.rows) {
    if (row.source_type === 'scrivener' || row.is_folder) continue;
    if (pieces.length >= 600) break;
    pieces.push({ id: row.id, title: (row.title || 'Untitled').trim(), location: '', inBook: false, order: pieces.length });
  }

  return { hasBook, pieces, byId: new Map(pieces.map((p) => [p.id, p])) };
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`*]/g, '')
    .replace(/[.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The document with exactly this title (ignoring case and quotes), preferring pieces in the book. */
export function resolvePiece(index: PieceIndex, title: string): PieceInfo | null {
  const key = normalizeTitle(title);
  if (!key) return null;
  const matches = index.pieces.filter((p) => normalizeTitle(p.title) === key);
  return matches.find((p) => p.inBook) ?? matches[0] ?? null;
}

/**
 * The piece a writer named: an exact title first, otherwise the one piece
 * whose title contains the words given (book pieces win a tie with others).
 */
export function findPieceByTitle(index: PieceIndex, title: string): PieceInfo | null {
  const exact = resolvePiece(index, title);
  if (exact) return exact;
  const key = normalizeTitle(title);
  if (key.length < 3) return null;
  const partial = index.pieces.filter((p) => normalizeTitle(p.title).includes(key));
  const inBook = partial.filter((p) => p.inBook);
  if (inBook.length === 1) return inBook[0]!;
  return partial.length === 1 ? partial[0]! : null;
}
