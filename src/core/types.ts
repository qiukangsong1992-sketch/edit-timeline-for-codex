import type { LineStats } from './stats';

export type AssistantId =
  | 'claude'
  | 'copilot'
  | 'gemini'
  | 'codex'
  | 'cursor'
  | 'manual'
  | 'unknown';

/** How a change reached the workspace. Distinguishes typing from a tool writing to disk. */
export type EditOrigin = 'user-typing' | 'external' | 'unknown';

export type ChangeKind = 'create' | 'change' | 'delete';

/** A single normalised filesystem event, after exclude globs and debouncing. */
export interface RawChange {
  /** Workspace-relative, forward-slashed. */
  path: string;
  kind: ChangeKind;
  /** Epoch milliseconds. */
  at: number;
  origin: EditOrigin;
  /** Exact pre/post images supplied by a Codex apply_patch hook. */
  hook?: {
    sessionId: string;
    turnId: string;
    transcriptPath?: string;
    /** null means the file did not exist; undefined means its content was unavailable. */
    before: string | null | undefined;
    after: string | null | undefined;
  };
}

/**
 * Why a file's content is or is not available for diff and restore.
 * Only `captured` supports restore.
 */
export type SnapshotState = 'captured' | 'unavailable' | 'binary' | 'too-large' | 'disabled';

export interface FileChange {
  path: string;
  workspaceRoot?: string;
  reason?: string;
  kind: ChangeKind;
  /** Blob ref for the content before this session's first edit. */
  beforeRef?: string;
  /** Blob ref for the content when the session closed. */
  afterRef?: string;
  snapshot: SnapshotState;
  added: number;
  deleted: number;
}

/** How the session's boundaries were determined, best fidelity first. */
export type DetectionMethod = 'api' | 'marker' | 'burst' | 'manual';

export interface AISession {
  id: string;
  workspaceRoot?: string;
  codexSessionId?: string;
  turnId?: string;
  toolUseIds?: string[];
  lastUpdatedAt?: number;
  incomplete?: boolean;
  attributionUncertain?: boolean;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds; absent while the session is open. */
  endedAt?: number;
  ai: AssistantId;
  prompt?: string;
  detection: DetectionMethod;
  files: FileChange[];
  /** Milliseconds from the first observed tool pre-hook to the latest post-hook; zero if the start is unknown. */
  duration: number;
  stats: LineStats;
  pinned?: boolean;
  notes?: string;
}

export interface Attribution {
  ai: AssistantId;
  prompt?: string;
  /** Identifies one Codex CLI turn even when two prompts have identical text. */
  turnId?: string;
  detection: DetectionMethod;
}

/** Reads file content the session manager needs but cannot obtain itself. */
export interface ContentSource {
  /**
   * Content as it was before the current change landed — from an in-memory
   * pre-change copy or version control. `undefined` when unrecoverable.
   */
  readBefore(path: string): Promise<string | undefined>;
  /** Content on disk now. `undefined` when the file is gone or unreadable. */
  readCurrent(path: string): Promise<string | undefined>;
}

export type CaptureOutcome =
  | { state: 'captured'; ref: string }
  | { state: 'unavailable' | 'binary' | 'too-large' | 'disabled' };

/** Content-addressed storage for file bodies. */
export interface SnapshotStore {
  put(content: string): Promise<CaptureOutcome>;
  get(ref: string): Promise<string | undefined>;
  /** Drop references held by these blobs; unreferenced blobs are deleted. */
  release(refs: string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface HistoryStore {
  all(): Promise<AISession[]>;
  append(session: AISession): Promise<void>;
  update(id: string, patch: Partial<AISession>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

/** Minimal disposable, so core modules need no `vscode` import. */
export interface Disposable {
  dispose(): void;
}

/** Deferred execution, injectable so tests control time. */
export interface Scheduler {
  now(): number;
  schedule(delayMs: number, fn: () => void): Disposable;
}

export interface SessionSettings {
  trackOnlyAIChanges: boolean;
  trackManualEdits: boolean;
  snapshotBeforeChange: boolean;
  sessionIdleTimeoutMs: number;
  sessionMaxDurationMs: number;
  storePrompts: boolean;
  enableStatistics: boolean;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  trackOnlyAIChanges: true,
  trackManualEdits: false,
  snapshotBeforeChange: true,
  sessionIdleTimeoutMs: 45_000,
  sessionMaxDurationMs: 600_000,
  storePrompts: true,
  enableStatistics: true,
};
