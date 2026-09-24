import { describe, expect, test } from 'vitest';
import { computeLineStats } from '../src/core/stats';

describe('computeLineStats', () => {
  test('reports no change for identical content', () => {
    expect(computeLineStats('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, deleted: 0 });
  });

  test('counts a line appended at the end', () => {
    expect(computeLineStats('a\nb', 'a\nb\nc')).toEqual({ added: 1, deleted: 0 });
  });

  test('counts a line inserted in the middle', () => {
    expect(computeLineStats('a\nc', 'a\nb\nc')).toEqual({ added: 1, deleted: 0 });
  });

  test('counts a removed line', () => {
    expect(computeLineStats('a\nb\nc', 'a\nc')).toEqual({ added: 0, deleted: 1 });
  });

  test('counts a modified line as one added and one deleted', () => {
    expect(computeLineStats('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, deleted: 1 });
  });

  test('counts every line of a new file as added', () => {
    expect(computeLineStats('', 'a\nb\nc')).toEqual({ added: 3, deleted: 0 });
  });

  test('counts every line of an emptied file as deleted', () => {
    expect(computeLineStats('a\nb\nc', '')).toEqual({ added: 0, deleted: 3 });
  });

  test('treats two empty files as unchanged', () => {
    expect(computeLineStats('', '')).toEqual({ added: 0, deleted: 0 });
  });

  test('ignores a difference of only a trailing newline', () => {
    expect(computeLineStats('a\nb', 'a\nb\n')).toEqual({ added: 0, deleted: 0 });
  });

  test('ignores line ending style when comparing', () => {
    expect(computeLineStats('a\r\nb\r\n', 'a\nb\n')).toEqual({ added: 0, deleted: 0 });
  });

  test('handles a whole-file rewrite', () => {
    expect(computeLineStats('a\nb', 'x\ny\nz')).toEqual({ added: 3, deleted: 2 });
  });

  test('does not double count repeated lines that moved', () => {
    // "b" survives; only the wrapper lines change.
    expect(computeLineStats('a\nb', 'b\nc')).toEqual({ added: 1, deleted: 1 });
  });

  test('falls back to coarse counts beyond the diff size guard', () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 60_000 }, (_, i) => `changed ${i}`).join('\n');

    // Too large for a quadratic diff: report totals rather than hanging.
    expect(computeLineStats(before, after)).toEqual({ added: 60_000, deleted: 60_000 });
  });
});
