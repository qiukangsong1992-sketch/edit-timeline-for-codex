import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  HISTORY_KEY,
  SessionHistoryStore,
  type KeyValueStore,
  type RetentionSettings,
} from '../src/core/historyStore';
import type { AISession } from '../src/core/types';

class FakeMemento implements KeyValueStore {
  data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
  }
}

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function session(id: string, overrides: Partial<AISession> = {}): AISession {
  return {
    id,
    startedAt: NOW,
    endedAt: NOW + 1000,
    ai: 'claude',
    detection: 'burst',
    files: [{ path: `${id}.ts`, kind: 'change', snapshot: 'captured', added: 1, deleted: 0 }],
    duration: 1000,
    stats: { added: 1, deleted: 0 },
    ...overrides,
  };
}

describe('SessionHistoryStore', () => {
  let memento: FakeMemento;
  let released: string[];
  let retention: RetentionSettings;

  function build() {
    return new SessionHistoryStore({
      memento,
      now: () => NOW,
      settings: () => retention,
      releaseRefs: async (refs) => {
        released.push(...refs);
      },
    });
  }

  beforeEach(() => {
    memento = new FakeMemento();
    released = [];
    retention = { maxHistorySessions: 500, autoCleanupDays: 30 };
  });

  test('returns an empty history for a fresh workspace', async () => {
    expect(await build().all()).toEqual([]);
  });

  test('round-trips an appended session', async () => {
    const store = build();
    await store.append(session('s1', { prompt: 'Add login' }));

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 's1', prompt: 'Add login', ai: 'claude' });
  });

  test('keeps history across instances backed by the same storage', async () => {
    await build().append(session('s1'));

    expect(await build().all()).toHaveLength(1);
  });

  test('returns sessions newest first', async () => {
    const store = build();
    await store.append(session('old', { startedAt: NOW - 5000 }));
    await store.append(session('new', { startedAt: NOW }));
    await store.append(session('middle', { startedAt: NOW - 2500 }));

    expect((await store.all()).map((s) => s.id)).toEqual(['new', 'middle', 'old']);
  });

  test('patches an existing session', async () => {
    const store = build();
    await store.append(session('s1'));

    await store.update('s1', { prompt: 'Renamed', pinned: true });

    expect(await store.all()).toMatchObject([{ id: 's1', prompt: 'Renamed', pinned: true }]);
  });

  test('ignores an update for an unknown session', async () => {
    const store = build();
    await store.append(session('s1'));

    await store.update('missing', { prompt: 'nope' });

    expect(await store.all()).toHaveLength(1);
  });

  test('removes sessions and releases their snapshots', async () => {
    const store = build();
    await store.append(
      session('s1', {
        files: [
          { path: 'a.ts', kind: 'change', snapshot: 'captured', beforeRef: 'b1', afterRef: 'a1', added: 0, deleted: 0 },
        ],
      }),
    );

    await store.remove(['s1']);

    expect(await store.all()).toEqual([]);
    expect(released.sort()).toEqual(['a1', 'b1']);
  });

  test('clear empties history and releases every snapshot', async () => {
    const store = build();
    await store.append(
      session('s1', {
        files: [{ path: 'a.ts', kind: 'change', snapshot: 'captured', beforeRef: 'b1', added: 0, deleted: 0 }],
      }),
    );
    await store.append(
      session('s2', {
        files: [{ path: 'b.ts', kind: 'change', snapshot: 'captured', beforeRef: 'b2', added: 0, deleted: 0 }],
      }),
    );

    await store.clear();

    expect(await store.all()).toEqual([]);
    expect(released.sort()).toEqual(['b1', 'b2']);
  });

  test('prunes the oldest sessions beyond the configured cap', async () => {
    retention = { maxHistorySessions: 3, autoCleanupDays: 0 };
    const store = build();
    for (let i = 0; i < 5; i++) {
      await store.append(session(`s${i}`, { startedAt: NOW + i }));
    }

    expect((await store.all()).map((s) => s.id)).toEqual(['s4', 's3', 's2']);
  });

  test('never prunes a pinned session to satisfy the cap', async () => {
    retention = { maxHistorySessions: 2, autoCleanupDays: 0 };
    const store = build();
    await store.append(session('pinned', { startedAt: NOW - 10_000, pinned: true }));
    await store.append(session('s1', { startedAt: NOW - 3000 }));
    await store.append(session('s2', { startedAt: NOW - 2000 }));
    await store.append(session('s3', { startedAt: NOW - 1000 }));

    const ids = (await store.all()).map((s) => s.id);
    expect(ids).toContain('pinned');
    expect(ids).not.toContain('s1');
  });

  test('deletes sessions older than the cleanup window', async () => {
    retention = { maxHistorySessions: 500, autoCleanupDays: 30 };
    const store = build();
    await store.append(session('ancient', { startedAt: NOW - 40 * DAY }));
    await store.append(session('recent', { startedAt: NOW - 2 * DAY }));

    expect((await store.all()).map((s) => s.id)).toEqual(['recent']);
  });

  test('keeps a pinned session past the cleanup window', async () => {
    retention = { maxHistorySessions: 500, autoCleanupDays: 30 };
    const store = build();
    await store.append(session('ancient', { startedAt: NOW - 40 * DAY, pinned: true }));

    expect((await store.all()).map((s) => s.id)).toEqual(['ancient']);
  });

  test('treats a cleanup window of zero as no age limit', async () => {
    retention = { maxHistorySessions: 500, autoCleanupDays: 0 };
    const store = build();
    await store.append(session('ancient', { startedAt: NOW - 400 * DAY }));

    expect((await store.all()).map((s) => s.id)).toEqual(['ancient']);
  });

  test('quarantines a corrupt payload instead of failing to load', async () => {
    await memento.update(HISTORY_KEY, { version: 1, sessions: 'not an array' });
    const store = build();

    expect(await store.all()).toEqual([]);
    expect([...memento.data.keys()].some((k) => k.includes('corrupt'))).toBe(true);
  });

  test('quarantines a payload written by a newer schema version', async () => {
    await memento.update(HISTORY_KEY, { version: 99, sessions: [session('future')] });
    const store = build();

    expect(await store.all()).toEqual([]);
  });

  test('drops individual entries that are not valid sessions', async () => {
    await memento.update(HISTORY_KEY, {
      version: 1,
      sessions: [session('good'), { id: 'bad' }, null, 42],
    });

    expect((await build().all()).map((s) => s.id)).toEqual(['good']);
  });

  test('announces every change so the view can refresh', async () => {
    const store = build();
    const listener = vi.fn();
    store.onDidChangeHistory(listener);

    await store.append(session('s1'));
    await store.update('s1', { pinned: true });
    await store.remove(['s1']);
    await store.clear();

    expect(listener).toHaveBeenCalledTimes(4);
  });

  test('a storage write failure keeps old history and does not release snapshots', async () => {
    const store = build();
    await store.append(session('s1', {
      files: [{ path: 'a.ts', kind: 'change', snapshot: 'captured', beforeRef: 'old-ref', added: 0, deleted: 0 }],
    }));
    memento.update = async () => { throw new Error('quota exceeded'); };
    await expect(store.remove(['s1'])).rejects.toThrow('quota exceeded');
    expect((await store.all()).map((item) => item.id)).toEqual(['s1']);
    expect(released).toEqual([]);
  });

  test('finds a session by id', async () => {
    const store = build();
    await store.append(session('s1'));

    expect((await store.find('s1'))?.id).toBe('s1');
    expect(await store.find('nope')).toBeUndefined();
  });
});
