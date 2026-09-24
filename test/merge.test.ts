import { describe, expect, test } from 'vitest';
import { mergeSessions } from '../src/core/merge';
import type { AISession, FileChange } from '../src/core/types';

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, kind: 'change', snapshot: 'captured', added: 0, deleted: 0, ...overrides };
}

function session(id: string, startedAt: number, overrides: Partial<AISession> = {}): AISession {
  return {
    id,
    startedAt,
    endedAt: startedAt + 1000,
    ai: 'claude',
    detection: 'burst',
    files: [file(`${id}.ts`)],
    duration: 1000,
    stats: { added: 0, deleted: 0 },
    ...overrides,
  };
}

describe('mergeSessions', () => {
  test('keeps the earlier session and absorbs the later files', () => {
    const earlier = session('a', 1000, { files: [file('one.ts')] });
    const later = session('b', 5000, { files: [file('two.ts')] });

    const merged = mergeSessions(earlier, later);

    expect(merged.files.map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
  });

  test('spans from the earlier start to the later end', () => {
    const earlier = session('a', 1000, { endedAt: 2000 });
    const later = session('b', 5000, { endedAt: 9000 });

    const merged = mergeSessions(earlier, later);

    expect(merged.endedAt).toBe(9000);
    expect(merged.duration).toBe(8000);
  });

  test('a file touched by both keeps the earliest before and the latest after', () => {
    const earlier = session('a', 1000, {
      files: [file('same.ts', { beforeRef: 'first', afterRef: 'mid' })],
    });
    const later = session('b', 5000, {
      files: [file('same.ts', { beforeRef: 'mid', afterRef: 'last' })],
    });

    const merged = mergeSessions(earlier, later);

    expect(merged.files).toHaveLength(1);
    expect(merged.files[0]).toMatchObject({ beforeRef: 'first', afterRef: 'last' });
  });

  test('a file created then deleted across the merge nets to a create, not a delete', () => {
    const earlier = session('a', 1000, { files: [file('temp.ts', { kind: 'create' })] });
    const later = session('b', 5000, { files: [file('temp.ts', { kind: 'delete' })] });

    // Never existed before the merge, doesn't exist after: reading this as
    // 'create' means undoing it deletes an already-absent path (safe), rather
    // than 'delete', which would write an unwanted empty file back.
    expect(mergeSessions(earlier, later).files[0].kind).toBe('create');
  });

  test('a file deleted then recreated across the merge reads as a change', () => {
    const earlier = session('a', 1000, { files: [file('flip.ts', { kind: 'delete' })] });
    const later = session('b', 5000, { files: [file('flip.ts', { kind: 'create' })] });

    // Existed before the merge and exists after: a net change, even though
    // each half individually looks like a delete or a create.
    expect(mergeSessions(earlier, later).files[0].kind).toBe('change');
  });

  test('a file changed then created keeps the original change kind', () => {
    const earlier = session('a', 1000, { files: [file('x.ts', { kind: 'create' })] });
    const later = session('b', 5000, { files: [file('x.ts', { kind: 'change' })] });

    expect(mergeSessions(earlier, later).files[0].kind).toBe('create');
  });

  test('recomputes statistics from the merged files', () => {
    const earlier = session('a', 1000, {
      files: [file('one.ts', { added: 5, deleted: 1 })],
      stats: { added: 5, deleted: 1 },
    });
    const later = session('b', 5000, {
      files: [file('two.ts', { added: 3, deleted: 2 })],
      stats: { added: 3, deleted: 2 },
    });

    expect(mergeSessions(earlier, later).stats).toEqual({ added: 8, deleted: 3 });
  });

  test('joins both prompts', () => {
    const merged = mergeSessions(
      session('a', 1000, { prompt: 'Add login' }),
      session('b', 5000, { prompt: 'Fix tests' }),
    );

    expect(merged.prompt).toBe('Add login · Fix tests');
  });

  test('keeps the single prompt when only one session has one', () => {
    expect(
      mergeSessions(session('a', 1000, { prompt: undefined }), session('b', 5000, { prompt: 'Fix tests' }))
        .prompt,
    ).toBe('Fix tests');
  });

  test('leaves the prompt unset when neither session has one', () => {
    expect(
      mergeSessions(session('a', 1000, { prompt: undefined }), session('b', 5000, { prompt: undefined }))
        .prompt,
    ).toBeUndefined();
  });

  test('keeps the merged session pinned if either was pinned', () => {
    expect(mergeSessions(session('a', 1000), session('b', 5000, { pinned: true })).pinned).toBe(true);
  });

  test('reports the more reliable of the two detection methods', () => {
    const merged = mergeSessions(
      session('a', 1000, { detection: 'burst', ai: 'unknown' }),
      session('b', 5000, { detection: 'api', ai: 'claude' }),
    );

    expect(merged.detection).toBe('api');
    expect(merged.ai).toBe('claude');
  });

  test('does not mutate either input', () => {
    const earlier = session('a', 1000, { files: [file('one.ts')] });
    const later = session('b', 5000, { files: [file('two.ts')] });

    mergeSessions(earlier, later);

    expect(earlier.files).toHaveLength(1);
    expect(later.files).toHaveLength(1);
  });
});
