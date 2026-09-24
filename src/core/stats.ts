export interface LineStats {
  added: number;
  deleted: number;
}

/**
 * Cells in the LCS table we are willing to fill. Beyond this the quadratic diff
 * is abandoned in favour of coarse totals — a stat is never worth a frozen UI.
 */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Counts lines added and deleted between two revisions of a file.
 *
 * Line endings and a single trailing newline are normalised away, so changing
 * only a file's EOL style or final newline reports no change.
 */
export function computeLineStats(before: string, after: string): LineStats {
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  let start = 0;
  const maxStart = Math.min(beforeLines.length, afterLines.length);
  while (start < maxStart && beforeLines[start] === afterLines[start]) {
    start++;
  }

  let end = 0;
  const maxEnd = Math.min(beforeLines.length, afterLines.length) - start;
  while (
    end < maxEnd &&
    beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) {
    end++;
  }

  const oldMiddle = beforeLines.slice(start, beforeLines.length - end);
  const newMiddle = afterLines.slice(start, afterLines.length - end);

  if (oldMiddle.length === 0) {
    return { added: newMiddle.length, deleted: 0 };
  }
  if (newMiddle.length === 0) {
    return { added: 0, deleted: oldMiddle.length };
  }
  if (oldMiddle.length * newMiddle.length > MAX_DIFF_CELLS) {
    return { added: newMiddle.length, deleted: oldMiddle.length };
  }

  const common = longestCommonSubsequenceLength(oldMiddle, newMiddle);
  return {
    added: newMiddle.length - common,
    deleted: oldMiddle.length - common,
  };
}

function toLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Rolling-row LCS: O(n·m) time, O(min(n,m)) memory. */
function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let previous = new Uint32Array(short.length + 1);
  let current = new Uint32Array(short.length + 1);

  for (const longLine of long) {
    for (let j = 0; j < short.length; j++) {
      current[j + 1] =
        longLine === short[j] ? previous[j] + 1 : Math.max(previous[j + 1], current[j]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[short.length];
}
