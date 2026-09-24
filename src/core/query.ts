import type { AISession, AssistantId } from './types';

export type TimeRange = 'all' | 'today' | 'yesterday' | 'week';

export interface SessionFilter {
  query: string;
  range: TimeRange;
  assistants: AssistantId[];
}

export interface DateGroup {
  label: string;
  sessions: AISession[];
}

export interface PeriodStatistics {
  sessions: number;
  files: number;
  uniqueFiles: number;
  added: number;
  deleted: number;
  averageFilesPerSession: number;
}

export interface Statistics {
  today: PeriodStatistics;
  allTime: PeriodStatistics;
  hottestFiles: { path: string; sessions: number }[];
  byAssistant: { ai: AssistantId; sessions: number }[];
}

const DAY_MS = 86_400_000;
const HOTTEST_FILE_LIMIT = 10;

/** Every whitespace-separated term must appear somewhere in the session. */
export function matchesQuery(session: AISession, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }

  const haystack = [session.prompt ?? '', session.notes ?? '', session.ai, ...session.files.map((f) => f.path)]
    .join('\n')
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

export function filterSessions(
  sessions: AISession[],
  filter: SessionFilter,
  now: number,
): AISession[] {
  const window = rangeBounds(filter.range, now);
  return sessions.filter((session) => {
    if (session.startedAt < window.from || session.startedAt >= window.to) {
      return false;
    }
    if (filter.assistants.length > 0 && !filter.assistants.includes(session.ai)) {
      return false;
    }
    return matchesQuery(session, filter.query);
  });
}

export function groupByDate(sessions: AISession[], now: number): DateGroup[] {
  const startOfToday = startOfDay(now);
  const startOfYesterday = startOfToday - DAY_MS;
  const startOfWeek = startOfToday - 6 * DAY_MS;

  const buckets: DateGroup[] = [
    { label: '今天', sessions: [] },
    { label: '昨天', sessions: [] },
    { label: '本周', sessions: [] },
    { label: '更早', sessions: [] },
  ];

  for (const session of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const index =
      session.startedAt >= startOfToday
        ? 0
        : session.startedAt >= startOfYesterday
          ? 1
          : session.startedAt >= startOfWeek
            ? 2
            : 3;
    buckets[index].sessions.push(session);
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

export function computeStatistics(sessions: AISession[], now: number): Statistics {
  const startOfToday = startOfDay(now);
  const todaySessions = sessions.filter((s) => s.startedAt >= startOfToday);

  const fileCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const path of new Set(session.files.map((f) => f.path))) {
      fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
  }

  const assistantCounts = new Map<AssistantId, number>();
  for (const session of sessions) {
    assistantCounts.set(session.ai, (assistantCounts.get(session.ai) ?? 0) + 1);
  }

  return {
    today: summarise(todaySessions),
    allTime: summarise(sessions),
    hottestFiles: [...fileCounts.entries()]
      .map(([path, count]) => ({ path, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path))
      .slice(0, HOTTEST_FILE_LIMIT),
    byAssistant: [...assistantCounts.entries()]
      .map(([ai, count]) => ({ ai, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions || a.ai.localeCompare(b.ai)),
  };
}

function summarise(sessions: AISession[]): PeriodStatistics {
  const files = sessions.reduce((total, s) => total + s.files.length, 0);
  const unique = new Set(sessions.flatMap((s) => s.files.map((f) => f.path)));

  return {
    sessions: sessions.length,
    files,
    uniqueFiles: unique.size,
    added: sessions.reduce((total, s) => total + s.stats.added, 0),
    deleted: sessions.reduce((total, s) => total + s.stats.deleted, 0),
    averageFilesPerSession: sessions.length === 0 ? 0 : round1(files / sessions.length),
  };
}

function rangeBounds(range: TimeRange, now: number): { from: number; to: number } {
  const startOfToday = startOfDay(now);
  switch (range) {
    case 'today':
      return { from: startOfToday, to: Number.POSITIVE_INFINITY };
    case 'yesterday':
      return { from: startOfToday - DAY_MS, to: startOfToday };
    case 'week':
      return { from: startOfToday - 6 * DAY_MS, to: Number.POSITIVE_INFINITY };
    case 'all':
      return { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY };
  }
}

/** Local midnight, so buckets line up with the user's calendar rather than UTC. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
