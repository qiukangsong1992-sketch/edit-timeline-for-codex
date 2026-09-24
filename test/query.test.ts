import { describe, expect, test } from 'vitest';
import {
  computeStatistics,
  filterSessions,
  groupByDate,
  matchesQuery,
  type SessionFilter,
} from '../src/core/query';
import type { AISession, AssistantId } from '../src/core/types';

// Wednesday 2023-11-15 12:00 local time.
const NOW = new Date(2023, 10, 15, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function session(
  id: string,
  overrides: Partial<AISession> & { paths?: string[]; ai?: AssistantId } = {},
): AISession {
  const { paths = [`${id}.ts`], ...rest } = overrides;
  return {
    id,
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR + 30_000,
    ai: 'claude',
    detection: 'burst',
    files: paths.map((path) => ({
      path,
      kind: 'change' as const,
      snapshot: 'captured' as const,
      added: 10,
      deleted: 2,
    })),
    duration: 30_000,
    stats: { added: 10 * paths.length, deleted: 2 * paths.length },
    ...rest,
  };
}

const NO_FILTER: SessionFilter = { query: '', range: 'all', assistants: [] };

describe('matchesQuery', () => {
  test('matches the prompt regardless of case', () => {
    const s = session('s1', { prompt: 'Implement JWT Authentication' });
    expect(matchesQuery(s, 'jwt')).toBe(true);
    expect(matchesQuery(s, 'AUTHENTICATION')).toBe(true);
  });

  test('matches a file path fragment', () => {
    const s = session('s1', { paths: ['src/auth/middleware.ts'] });
    expect(matchesQuery(s, 'middleware')).toBe(true);
    expect(matchesQuery(s, 'src/auth')).toBe(true);
  });

  test('matches the assistant name', () => {
    expect(matchesQuery(session('s1', { ai: 'copilot' }), 'copilot')).toBe(true);
  });

  test('matches notes', () => {
    expect(matchesQuery(session('s1', { notes: 'needs optimising later' }), 'optimising')).toBe(true);
  });

  test('does not match unrelated text', () => {
    expect(matchesQuery(session('s1', { prompt: 'Add login' }), 'payment')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(matchesQuery(session('s1'), '')).toBe(true);
    expect(matchesQuery(session('s1'), '   ')).toBe(true);
  });

  test('requires every whitespace-separated term to match', () => {
    const s = session('s1', { prompt: 'Add login', paths: ['auth.ts'] });
    expect(matchesQuery(s, 'login auth')).toBe(true);
    expect(matchesQuery(s, 'login payment')).toBe(false);
  });
});

describe('filterSessions', () => {
  const today = session('today', { startedAt: NOW - HOUR });
  const yesterday = session('yesterday', { startedAt: NOW - DAY });
  const lastWeek = session('lastWeek', { startedAt: NOW - 5 * DAY });
  const ancient = session('ancient', { startedAt: NOW - 60 * DAY });
  const all = [today, yesterday, lastWeek, ancient];

  test('returns everything when nothing is filtered', () => {
    expect(filterSessions(all, NO_FILTER, NOW).map((s) => s.id)).toEqual([
      'today',
      'yesterday',
      'lastWeek',
      'ancient',
    ]);
  });

  test('limits to today', () => {
    expect(filterSessions(all, { ...NO_FILTER, range: 'today' }, NOW).map((s) => s.id)).toEqual([
      'today',
    ]);
  });

  test('limits to yesterday only', () => {
    expect(filterSessions(all, { ...NO_FILTER, range: 'yesterday' }, NOW).map((s) => s.id)).toEqual([
      'yesterday',
    ]);
  });

  test('limits to the last seven days', () => {
    expect(filterSessions(all, { ...NO_FILTER, range: 'week' }, NOW).map((s) => s.id)).toEqual([
      'today',
      'yesterday',
      'lastWeek',
    ]);
  });

  test('limits to a set of assistants', () => {
    const mixed = [session('a', { ai: 'claude' }), session('b', { ai: 'copilot' })];

    expect(
      filterSessions(mixed, { ...NO_FILTER, assistants: ['copilot'] }, NOW).map((s) => s.id),
    ).toEqual(['b']);
  });

  test('combines a query with a range', () => {
    const mixed = [
      session('match', { startedAt: NOW - HOUR, prompt: 'fix tests' }),
      session('wrongDay', { startedAt: NOW - 10 * DAY, prompt: 'fix tests' }),
      session('wrongText', { startedAt: NOW - HOUR, prompt: 'add feature' }),
    ];

    expect(
      filterSessions(mixed, { query: 'tests', range: 'week', assistants: [] }, NOW).map((s) => s.id),
    ).toEqual(['match']);
  });
});

describe('groupByDate', () => {
  test('buckets sessions into Today, Yesterday, This week and Older', () => {
    const groups = groupByDate(
      [
        session('t1', { startedAt: NOW - HOUR }),
        session('t2', { startedAt: NOW - 2 * HOUR }),
        session('y1', { startedAt: NOW - DAY }),
        session('w1', { startedAt: NOW - 4 * DAY }),
        session('o1', { startedAt: NOW - 40 * DAY }),
      ],
      NOW,
    );

    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '本周', '更早']);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(groups[3].sessions.map((s) => s.id)).toEqual(['o1']);
  });

  test('omits empty buckets', () => {
    const groups = groupByDate([session('o1', { startedAt: NOW - 40 * DAY })], NOW);

    expect(groups.map((g) => g.label)).toEqual(['更早']);
  });

  test('keeps sessions newest first inside a bucket', () => {
    const groups = groupByDate(
      [
        session('older', { startedAt: NOW - 5 * HOUR }),
        session('newer', { startedAt: NOW - HOUR }),
      ],
      NOW,
    );

    expect(groups[0].sessions.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  test('treats a session just after midnight as today', () => {
    const justAfterMidnight = new Date(2023, 10, 15, 0, 5, 0).getTime();

    const groups = groupByDate([session('early', { startedAt: justAfterMidnight })], NOW);

    expect(groups[0].label).toBe('今天');
  });

  test('treats a session just before midnight as yesterday', () => {
    const justBeforeMidnight = new Date(2023, 10, 14, 23, 55, 0).getTime();

    const groups = groupByDate([session('late', { startedAt: justBeforeMidnight })], NOW);

    expect(groups[0].label).toBe('昨天');
  });

  test('returns nothing for an empty history', () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});

describe('computeStatistics', () => {
  test('totals sessions, files and lines for today', () => {
    const stats = computeStatistics(
      [
        session('a', { startedAt: NOW - HOUR, paths: ['a.ts', 'b.ts'] }),
        session('b', { startedAt: NOW - 2 * HOUR, paths: ['c.ts'] }),
        session('old', { startedAt: NOW - 10 * DAY, paths: ['d.ts'] }),
      ],
      NOW,
    );

    expect(stats.today).toMatchObject({ sessions: 2, files: 3, added: 30, deleted: 6 });
    expect(stats.allTime).toMatchObject({ sessions: 3, files: 4, added: 40, deleted: 8 });
  });

  test('reports the average files per session', () => {
    const stats = computeStatistics(
      [session('a', { paths: ['a.ts', 'b.ts', 'c.ts'] }), session('b', { paths: ['d.ts'] })],
      NOW,
    );

    expect(stats.today.averageFilesPerSession).toBe(2);
  });

  test('counts a file edited in two sessions once in the unique total', () => {
    const stats = computeStatistics(
      [session('a', { paths: ['same.ts'] }), session('b', { paths: ['same.ts'] })],
      NOW,
    );

    expect(stats.today.files).toBe(2);
    expect(stats.today.uniqueFiles).toBe(1);
  });

  test('ranks the most frequently edited files', () => {
    const stats = computeStatistics(
      [
        session('a', { paths: ['hot.ts', 'cold.ts'] }),
        session('b', { paths: ['hot.ts'] }),
        session('c', { paths: ['hot.ts'] }),
      ],
      NOW,
    );

    expect(stats.hottestFiles[0]).toEqual({ path: 'hot.ts', sessions: 3 });
  });

  test('breaks totals down by assistant', () => {
    const stats = computeStatistics(
      [session('a', { ai: 'claude' }), session('b', { ai: 'claude' }), session('c', { ai: 'copilot' })],
      NOW,
    );

    expect(stats.byAssistant).toEqual([
      { ai: 'claude', sessions: 2 },
      { ai: 'copilot', sessions: 1 },
    ]);
  });

  test('returns zeros rather than NaN for an empty history', () => {
    const stats = computeStatistics([], NOW);

    expect(stats.today).toEqual({
      sessions: 0,
      files: 0,
      uniqueFiles: 0,
      added: 0,
      deleted: 0,
      averageFilesPerSession: 0,
    });
    expect(stats.hottestFiles).toEqual([]);
  });
});
