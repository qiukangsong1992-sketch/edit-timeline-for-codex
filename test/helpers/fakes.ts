import type {
  AISession,
  CaptureOutcome,
  ContentSource,
  Disposable,
  HistoryStore,
  Scheduler,
  SnapshotStore,
} from '../../src/core/types';

/** Deterministic clock plus timer queue. Tests advance time explicitly. */
export class FakeScheduler implements Scheduler {
  private current = 1_000_000;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, fn: () => void): Disposable {
    const timer = { at: this.current + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return {
      dispose: () => {
        timer.cancelled = true;
      },
    };
  }

  /** Move the clock forward, firing any timers due along the way. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      due.cancelled = true;
      this.current = due.at;
      due.fn();
    }
    this.current = target;
  }

  get pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

/** Content-addressed store backed by a Map, with the same guards as the real one. */
export class FakeSnapshotStore implements SnapshotStore {
  readonly blobs = new Map<string, string>();
  private refCounts = new Map<string, number>();
  private nextRef = 1;
  maxBytes = 1_048_576;
  enabled = true;

  async put(content: string): Promise<CaptureOutcome> {
    if (!this.enabled) {
      return { state: 'disabled' };
    }
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
      return { state: 'too-large' };
    }
    for (const [ref, existing] of this.blobs) {
      if (existing === content) {
        this.refCounts.set(ref, (this.refCounts.get(ref) ?? 0) + 1);
        return { state: 'captured', ref };
      }
    }
    const ref = `blob${this.nextRef++}`;
    this.blobs.set(ref, content);
    this.refCounts.set(ref, 1);
    return { state: 'captured', ref };
  }

  async get(ref: string): Promise<string | undefined> {
    return this.blobs.get(ref);
  }

  async release(refs: string[]): Promise<void> {
    for (const ref of refs) {
      const next = (this.refCounts.get(ref) ?? 0) - 1;
      if (next <= 0) {
        this.refCounts.delete(ref);
        this.blobs.delete(ref);
      } else {
        this.refCounts.set(ref, next);
      }
    }
  }

  async clear(): Promise<void> {
    this.blobs.clear();
    this.refCounts.clear();
  }
}

export class FakeHistoryStore implements HistoryStore {
  sessions: AISession[] = [];

  async all(): Promise<AISession[]> {
    return this.sessions.map((s) => structuredClone(s));
  }

  async append(session: AISession): Promise<void> {
    this.sessions.push(structuredClone(session));
  }

  async update(id: string, patch: Partial<AISession>): Promise<void> {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index >= 0) {
      this.sessions[index] = { ...this.sessions[index], ...structuredClone(patch) };
    }
  }

  async remove(ids: string[]): Promise<void> {
    this.sessions = this.sessions.filter((s) => !ids.includes(s.id));
  }

  async clear(): Promise<void> {
    this.sessions = [];
  }
}

/**
 * Two-layer fake filesystem: `before` is what a pre-change copy would yield,
 * `current` is what is on disk now.
 */
export class FakeContentSource implements ContentSource {
  before = new Map<string, string>();
  current = new Map<string, string>();

  async readBefore(path: string): Promise<string | undefined> {
    return this.before.get(path);
  }

  async readCurrent(path: string): Promise<string | undefined> {
    return this.current.get(path);
  }

  /** Simulate a write: current content becomes `content`, before keeps the old value. */
  write(path: string, content: string): void {
    if (!this.before.has(path)) {
      this.before.set(path, this.current.get(path) ?? '');
    }
    this.current.set(path, content);
  }

  seed(path: string, content: string): void {
    this.before.set(path, content);
    this.current.set(path, content);
  }
}

export function sequentialIds(prefix = 's'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
