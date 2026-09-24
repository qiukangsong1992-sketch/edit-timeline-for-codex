import type { AISession, FileChange, HistoryStore, SnapshotStore } from './types';

export interface WorkspaceWriter {
  /** Content currently on disk, or undefined if the file does not exist. */
  read(path: string, workspaceRoot?: string): Promise<string | undefined>;
  write(path: string, content: string, workspaceRoot?: string): Promise<void>;
  delete(path: string, workspaceRoot?: string): Promise<void>;
}

export interface RestoreReport {
  restored: string[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
}

/**
 * One file a restore overwrote, with a snapshot of what was there first.
 *
 * `kind` describes what undoing this entry would mean: a file the restore
 * deleted reads as `delete`, and one it brought back reads as `create`.
 */
export interface RestoredEntry {
  path: string;
  workspaceRoot?: string;
  kind: FileChange['kind'];
  beforeRef?: string;
}

export interface RestoreServiceDeps {
  history: HistoryStore;
  snapshots: SnapshotStore;
  writer: WorkspaceWriter;
  /** Records the restore itself as a session, so a restore can be undone. */
  recordRestore: (entries: RestoredEntry[], label: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Puts files back the way they were before a session touched them.
 *
 * One failure never aborts the rest: every file is attempted and the report
 * says exactly what happened to each.
 */
export class RestoreService {
  constructor(private readonly deps: RestoreServiceDeps) {}

  async restoreFile(sessionId: string, path: string): Promise<RestoreReport> {
    const session = await this.findSession(sessionId);
    if (!session) {
      return report({ failed: [{ path, reason: '记录不存在' }] });
    }

    const file = session.files.find((f) => f.path === path);
    if (!file) {
      return report({ failed: [{ path, reason: '文件不属于这条记录' }] });
    }

    return this.apply(session, [file]);
  }

  async restoreSession(sessionId: string): Promise<RestoreReport> {
    const session = await this.findSession(sessionId);
    if (!session) {
      return report({ failed: [{ path: sessionId, reason: '记录不存在' }] });
    }
    return this.apply(session, session.files);
  }

  /** The files a restore would actually rewrite — used to confirm with the user. */
  async restorablePaths(sessionId: string): Promise<string[]> {
    const session = await this.findSession(sessionId);
    if (!session) {
      return [];
    }
    return session.files.filter(isRestorable).map((f) => f.path);
  }

  // ---------------------------------------------------------------- internals

  private async findSession(id: string): Promise<AISession | undefined> {
    return (await this.deps.history.all()).find((s) => s.id === id);
  }

  private async apply(session: AISession, files: FileChange[]): Promise<RestoreReport> {
    const result: RestoreReport = { restored: [], skipped: [], failed: [] };
    const undoEntries: RestoredEntry[] = [];

    for (const file of files) {
      if (!isRestorable(file)) {
        result.skipped.push({ path: file.path, reason: file.reason || '没有修改前快照' });
        continue;
      }

      const before = await this.deps.snapshots.get(file.beforeRef);
      if (before === undefined) {
        result.skipped.push({ path: file.path, reason: '快照已不存在' });
        continue;
      }

      // Snapshot what we are about to overwrite, so this restore can be undone.
      const overwritten = await this.captureOverwritten(file.path, file.workspaceRoot);

      try {
        if (file.kind === 'create') {
          // The session created this file, so "before" means it did not exist.
          await this.deps.writer.delete(file.path, file.workspaceRoot);
        } else {
          await this.deps.writer.write(file.path, before, file.workspaceRoot);
        }
        result.restored.push(file.path);
        undoEntries.push({
          path: file.path,
          workspaceRoot: file.workspaceRoot,
          // Undoing a restore reverses the direction of the change.
          kind: file.kind === 'create' ? 'delete' : file.kind === 'delete' ? 'create' : 'change',
          beforeRef: overwritten,
        });
      } catch (error) {
        const reason = describe(error);
        this.deps.log?.(`could not restore ${file.path}: ${reason}`);
        result.failed.push({ path: file.path, reason });
      }
    }

    if (undoEntries.length > 0) {
      try {
        await this.deps.recordRestore(undoEntries, `恢复记录 ${session.id}`);
      } catch (error) {
        this.deps.log?.(`could not record restore: ${describe(error)}`);
      }
    }

    return result;
  }

  private async captureOverwritten(path: string, workspaceRoot?: string): Promise<string | undefined> {
    try {
      // Nonexistence is a legitimate "before" state — the same convention
      // captureBefore uses for a freshly created file — not a reason to give up.
      // Without this, restoring a deleted file back into existence produces an
      // undo entry with no snapshot at all, which then can never itself be
      // restored.
      const current = (await this.deps.writer.read(path, workspaceRoot)) ?? '';
      const outcome = await this.deps.snapshots.put(current);
      return outcome.state === 'captured' ? outcome.ref : undefined;
    } catch (error) {
      this.deps.log?.(`could not snapshot ${path} before restoring: ${describe(error)}`);
      return undefined;
    }
  }
}

function isRestorable(file: FileChange): file is FileChange & { beforeRef: string } {
  return file.snapshot === 'captured' && typeof file.beforeRef === 'string';
}

function report(partial: Partial<RestoreReport>): RestoreReport {
  return { restored: [], skipped: [], failed: [], ...partial };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
