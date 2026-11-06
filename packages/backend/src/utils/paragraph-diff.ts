/**
 * Paragraph-level diff for prose.
 *
 * Revisions to an essay read best, for a person or a model, as passages cut,
 * added, or rewritten, with a little context to find them. Word-level diffs of
 * prose are noisy. This compares paragraphs (lines) with a longest common
 * subsequence and groups the differences into passages.
 */

export interface DiffHunk {
  /** Paragraphs from the old version: cut, or the text before a rewrite. */
  before: string[];
  /** Paragraphs in the new version: added, or the rewrite. */
  after: string[];
  /** The unchanged paragraph just before this change, or null at the start. */
  anchor: string | null;
}

export interface ParagraphDiff {
  hunks: DiffHunk[];
  /** Change in word count, new minus old. */
  wordDelta: number;
}

/** Above this many comparisons, the changed middle is treated as one rewrite. */
const MAX_CELLS = 4_000_000;

import { decodeCp1252Controls } from './rtf-parser.js';

/**
 * Debris the RTF text extraction leaves behind: Scrivener comment links
 * (whose ids change between snapshots, which would read as edits), style
 * placeholders, the backslash that ends most paragraphs, and curly quotes
 * decoded as control characters (so a fixed decoder doesn't look like edits).
 */
function cleanParagraph(p: string): string {
  return decodeCp1252Controls(p)
    .replace(/\\?\*?HYPERLINK "scrivcmt:\/\/[^"]*"/g, '')
    .replace(/<\$Scr[A-Za-z_]*>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(\s*\\)+$/g, '')
    .trim();
}

/** A line left over from an RTF table, like "\*;;;", with no words in it. */
const DEBRIS_LINE = /^[\\*;\s]*$/;

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(cleanParagraph)
    .filter((p) => p && !DEBRIS_LINE.test(p));
}

/** The text as the diff sees it, for telling whether two versions really differ. */
export function comparableText(text: string): string {
  return splitParagraphs(text).join('\n');
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Index pairs [i, j] where a[i] === b[j], forming a longest common subsequence. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_CELLS) return [];
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function diffParagraphs(oldText: string, newText: string): ParagraphDiff {
  const a = splitParagraphs(oldText);
  const b = splitParagraphs(newText);

  // The common opening and ending are unchanged; compare only the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const matches = lcsPairs(a.slice(start, endA), b.slice(start, endB)).map(
    ([i, j]): [number, number] => [i + start, j + start]
  );
  matches.push([endA, endB]); // the unchanged ending closes the last change

  const hunks: DiffHunk[] = [];
  let ia = start;
  let ib = start;
  for (const [ma, mb] of matches) {
    if (ma > ia || mb > ib) {
      hunks.push({ before: a.slice(ia, ma), after: b.slice(ib, mb), anchor: ia > 0 ? a[ia - 1]! : null });
    }
    ia = ma + 1;
    ib = mb + 1;
  }

  return { hunks, wordDelta: countWords(b.join(' ')) - countWords(a.join(' ')) };
}

/** Keep the opening and the end of a long passage. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.65)).trimEnd();
  const tail = text.slice(text.length - Math.floor(max * 0.3)).trimStart();
  return `${head} … ${tail}`;
}

function quote(paragraphs: string[], max: number): string {
  return `"${clip(paragraphs.join(' / '), max)}"`;
}

/** Words of context kept on each side of a change inside a rewritten passage. */
const CONTEXT_WORDS = 10;

/**
 * Quote a rewrite as the stretch that changed, with a few words of context,
 * so an edit in the middle of a long paragraph is visible in both versions.
 */
function quoteRewrite(before: string[], after: string[], max: number): [string, string] {
  const a = before.join(' / ').split(' ');
  const b = after.join(' / ').split(' ');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const from = Math.max(0, prefix - CONTEXT_WORDS);
  const show = (words: string[]): string => {
    const to = Math.min(words.length, words.length - suffix + CONTEXT_WORDS);
    const text = clip(words.slice(from, to).join(' '), max);
    return `"${from > 0 ? '…' : ''}${text}${to < words.length ? '…' : ''}"`;
  };
  return [show(a), show(b)];
}

/** e.g. "3 passages changed: 2 rewritten, 1 cut" */
export function describeDiff(diff: ParagraphDiff): string {
  if (diff.hunks.length === 0) return 'no changes to the text';
  let rewritten = 0;
  let cut = 0;
  let added = 0;
  for (const h of diff.hunks) {
    if (h.before.length > 0 && h.after.length > 0) rewritten++;
    else if (h.before.length > 0) cut++;
    else added++;
  }
  const parts = [
    rewritten > 0 ? `${rewritten} rewritten` : '',
    cut > 0 ? `${cut} cut` : '',
    added > 0 ? `${added} added` : '',
  ].filter(Boolean);
  const n = diff.hunks.length;
  return `${n} passage${n === 1 ? '' : 's'} changed: ${parts.join(', ')}`;
}

/**
 * Render the changes as plain text within `budget` characters. Passages are
 * listed in document order; long ones keep their opening and end.
 */
export function renderDiff(diff: ParagraphDiff, budget: number, quoteChars = 500): string {
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const hunk of diff.hunks) {
    const where = hunk.anchor ? `after "…${hunk.anchor.slice(-80).trimStart()}"` : 'at the start';
    let block: string;
    if (hunk.before.length > 0 && hunk.after.length > 0) {
      const [before, after] = quoteRewrite(hunk.before, hunk.after, quoteChars);
      block = `- Rewritten, ${where}:\n    Before: ${before}\n    After: ${after}`;
    } else if (hunk.before.length > 0) {
      block = `- Cut, ${where}: ${quote(hunk.before, quoteChars)} (${countWords(hunk.before.join(' '))} words)`;
    } else {
      block = `- Added ${where}: ${quote(hunk.after, quoteChars)}`;
    }
    if (shown > 0 && used + block.length > budget) break;
    lines.push(block);
    used += block.length + 1;
    shown++;
  }
  const hidden = diff.hunks.length - shown;
  if (hidden > 0) lines.push(`- (${hidden} more change${hidden === 1 ? '' : 's'} not shown)`);
  return lines.join('\n');
}
