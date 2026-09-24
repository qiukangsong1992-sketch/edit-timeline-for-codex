import { Emitter } from './emitter';
import type { AISession, Disposable, FileChange, HistoryStore } from './types';

export const HISTORY_KEY = 'editTimelineForCodex.history.v1';
const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

export interface RetentionSettings {
  maxHistorySessions: number;
  autoCleanupDays: number;
}

export interface SessionHistoryStoreDeps {
  memento: KeyValueStore;
  now: () => number;
  settings: () => RetentionSettings;
  releaseRefs: (refs: string[]) => Promise<void>;
  log?: (message: string) => void;
}

interface HistoryPayload {
  version: number;
  sessions: AISession[];
}

/**
 * Session metadata in a key/value store, newest first.
 *
 * File bodies are deliberately absent — only blob refs are kept here, so the
 * payload stays small enough for VS Code's workspace state.
 */
export class SessionHistoryStore implements HistoryStore {
  private cache: AISession[] | undefined;
  private readonly changeEmitter = new Emitter<string | undefined>();

  readonly onDidChangeHistory = this.changeEmitter.event;

  constructor(private readonly deps: SessionHistoryStoreDeps) {}

  async all(): Promise<AISession[]> {
    const sessions = await this.load();
    return sessions.map((s) => structuredClone(s));
  }

  async find(id: string): Promise<AISession | undefined> {
    const found = (await this.load()).find((s) => s.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async append(session: AISession): Promise<void> {
    const sessions = [structuredClone(session), ...(await this.load())];
    sessions.sort((a, b) => b.startedAt - a.startedAt);
    const { kept, doomed } = this.applyRetention(sessions);
    await this.persist(kept);
    await this.releaseSnapshots(doomed);
  }

  async update(id: string, patch: Partial<AISession>): Promise<void> {
    const sessions = await this.load();
    const index = sessions.findIndex((s) => s.id === id);
    if (index < 0) {
      return;
    }
    const updated = sessions.map((entry) => structuredClone(entry));
    updated[index] = { ...updated[index], ...structuredClone(patch), id };
    await this.persist(updated, { changedId: id });
  }

  async remove(ids: string[]): Promise<void> {
    const sessions = await this.load();
    const doomed = sessions.filter((s) => ids.includes(s.id));
    if (doomed.length === 0) {
      return;
    }
    await this.persist(sessions.filter((s) => !ids.includes(s.id)));
    await this.releaseSnapshots(doomed);
  }

  async clear(): Promise<void> {
    const old = await this.load();
    await this.persist([]);
    await this.releaseSnapshots(old);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------- internals

  private async load(): Promise<AISession[]> {
    if (this.cache) {
      return this.cache;
    }

    const raw = this.deps.memento.get<unknown>(HISTORY_KEY);
    if (raw === undefined) {
      this.cache = [];
      return this.cache;
    }

    const parsed = this.parse(raw);
    if (!parsed) {
      await this.quarantine(raw);
      this.cache = [];
      return this.cache;
    }

    this.cache = parsed;
    return this.cache;
  }

  private parse(raw: unknown): AISession[] | undefined {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const payload = raw as Partial<HistoryPayload>;
    if (payload.version !== SCHEMA_VERSION || !Array.isArray(payload.sessions)) {
      return undefined;
    }
    // A single bad entry must not cost the user the rest of their history.
    return payload.sessions
      .filter(isSession)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private async quarantine(raw: unknown): Promise<void> {
    const key = `${HISTORY_KEY}.corrupt-${this.deps.now()}`;
    this.deps.log?.(`history payload unreadable; moved to ${key}`);
    try {
      await this.deps.memento.update(key, raw);
      await this.deps.memento.update(HISTORY_KEY, undefined);
    } catch (error) {
      this.deps.log?.(`could not quarantine history: ${describe(error)}`);
    }
  }

  async prune(): Promise<void> {
    const { kept, doomed } = this.applyRetention(await this.load());
    if (!doomed.length) return;
    await this.persist(kept);
    await this.releaseSnapshots(doomed);
  }

  private applyRetention(sessions: AISession[]): { kept: AISession[]; doomed: AISession[] } {
    const { maxHistorySessions, autoCleanupDays } = this.deps.settings();
    const cutoff = autoCleanupDays > 0 ? this.deps.now() - autoCleanupDays * DAY_MS : undefined;

    const kept: AISession[] = [];
    const doomed: AISession[] = [];
    const unpinnedKept = new Map<string, number>();

    for (const session of sessions) {
      if (session.pinned) {
        kept.push(session);
        continue;
      }
      const workspace = session.workspaceRoot || '';
      const tooOld = cutoff !== undefined && session.startedAt < cutoff;
      const overCap = (unpinnedKept.get(workspace) || 0) >= maxHistorySessions;
      if (tooOld || overCap) {
        doomed.push(session);
      } else {
        kept.push(session);
        unpinnedKept.set(workspace, (unpinnedKept.get(workspace) || 0) + 1);
      }
    }

    return { kept, doomed };
  }

  private async releaseSnapshots(sessions: AISession[]): Promise<void> {
    const refs = sessions.flatMap((s) => s.files.flatMap(refsOf));
    if (refs.length === 0) {
      return;
    }
    try {
      await this.deps.releaseRefs(refs);
    } catch (error) {
      this.deps.log?.(`could not release snapshots: ${describe(error)}`);
    }
  }

  private async persist(sessions: AISession[], options?: { silent?: boolean; changedId?: string }): Promise<void> {
    const payload: HistoryPayload = { version: SCHEMA_VERSION, sessions };
    await this.deps.memento.update(HISTORY_KEY, payload);
    this.cache = sessions;
    if (!options?.silent) {
      this.changeEmitter.fire(options?.changedId);
    }
  }
}

function refsOf(file: FileChange): string[] {
  return [file.beforeRef, file.afterRef].filter((ref): ref is string => typeof ref === 'string');
}

function isSession(value: unknown): value is AISession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AISession>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.startedAt === 'number' &&
    Array.isArray(candidate.files) &&
    typeof candidate.stats === 'object' &&
    candidate.stats !== null
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Disposable };
