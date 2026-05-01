/**
 * Word-level diff utility using diff-match-patch.
 */

import DiffMatchPatch from 'diff-match-patch';

export type DiffSegmentType = 'add' | 'remove' | 'equal';

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
}

const dmp = new DiffMatchPatch();

/**
 * Compute a word-level diff between two texts.
 * Returns an array of diff segments with type (add/remove/equal) and text.
 */
export function computeWordDiff(oldText: string, newText: string): DiffSegment[] {
  // Use diff_main for character-level diff, then clean up semantically
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  return diffs.map(([operation, text]) => {
    let type: DiffSegmentType;
    switch (operation) {
      case DiffMatchPatch.DIFF_INSERT:
        type = 'add';
        break;
      case DiffMatchPatch.DIFF_DELETE:
        type = 'remove';
        break;
      default:
        type = 'equal';
        break;
    }
    return { type, text };
  });
}
