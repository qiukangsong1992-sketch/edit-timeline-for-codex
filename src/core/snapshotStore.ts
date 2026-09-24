import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { CaptureOutcome, SnapshotStore } from './types';
import type { KeyValueStore } from './historyStore';

export const BLOB_INDEX_KEY = 'editTimelineForCodex.blobs.v1';

export interface BlobFileSystem {
  read(name: string): Promise<Uint8Array | undefined>;
  write(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface SnapshotSettings {
  maxSnapshotBytes: number;
}

export interface BlobSnapshotStoreDeps {
  fs: BlobFileSystem;
  memento: KeyValueStore;
  settings: () => SnapshotSettings;
  log?: (message: string) => void;
}

/**
 * Content-addressed, gzipped file bodies with reference counting.
 *
 * A file that survives ten sessions unchanged is stored once. Refcounts live in
 * the key/value store so they survive a restart; the blobs live on disk, outside
 * the workspace, so they never show up in `git status`.
 */
export class BlobSnapshotStore implements SnapshotStore {
  private index: Record<string, number> | undefined;

  constructor(private readonly deps: BlobSnapshotStoreDeps) {}

  async put(content: string): Promise<CaptureOutcome> {
    // A NUL byte means this was never text; storing it would corrupt on restore.
    if (content.includes('\u0000')) {
      return { state: 'binary' };
    }

    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > this.deps.settings().maxSnapshotBytes) {
      return { state: 'too-large' };
    }

    const ref = createHash('sha256').update(bytes).digest('hex');
    const index = this.loadIndex();

    if ((index[ref] ?? 0) > 0) {
      index[ref] += 1;
      await this.saveIndex(index);
      return { state: 'captured', ref };
    }

    try {
      await this.deps.fs.write(ref, gzipSync(bytes));
    } catch (error) {
      this.deps.log?.(`snapshot write failed: ${describe(error)}`);
      return { state: 'unavailable' };
    }

    index[ref] = 1;
    await this.saveIndex(index);
    return { state: 'captured', ref };
  }

  async get(ref: string): Promise<string | undefined> {
    try {
      const data = await this.deps.fs.read(ref);
      if (!data) {
        return undefined;
      }
      return gunzipSync(data).toString('utf8');
    } catch (error) {
      this.deps.log?.(`snapshot read failed for ${ref}: ${describe(error)}`);
      return undefined;
    }
  }

  async release(refs: string[]): Promise<void> {
    if (refs.length === 0) {
      return;
    }
    const index = this.loadIndex();
    const orphans: string[] = [];

    for (const ref of refs) {
      const remaining = (index[ref] ?? 0) - 1;
      if (remaining > 0) {
        index[ref] = remaining;
      } else if (ref in index) {
        delete index[ref];
        orphans.push(ref);
      }
    }

    await this.deleteBlobs(orphans);
    await this.saveIndex(index);
  }

  /** Drops blobs on disk that no surviving session references. */
  async collectGarbage(liveRefs: string[]): Promise<void> {
    const live = new Set(liveRefs);
    let onDisk: string[];
    try {
      onDisk = await this.deps.fs.list();
    } catch (error) {
      this.deps.log?.(`could not list snapshots: ${describe(error)}`);
      return;
    }

    await this.deleteBlobs(onDisk.filter((name) => !live.has(name)));

    const index = this.loadIndex();
    const rebuilt: Record<string, number> = {};
    for (const ref of live) {
      rebuilt[ref] = index[ref] ?? 1;
    }
    await this.saveIndex(rebuilt);
  }

  async clear(): Promise<void> {
    try {
      await this.deps.fs.clear();
    } catch (error) {
      this.deps.log?.(`could not clear snapshots: ${describe(error)}`);
    }
    await this.saveIndex({});
  }

  // ---------------------------------------------------------------- internals

  private async deleteBlobs(refs: string[]): Promise<void> {
    for (const ref of refs) {
      try {
        await this.deps.fs.delete(ref);
      } catch (error) {
        this.deps.log?.(`could not delete snapshot ${ref}: ${describe(error)}`);
      }
    }
  }

  private loadIndex(): Record<string, number> {
    if (!this.index) {
      const stored = this.deps.memento.get<Record<string, number>>(BLOB_INDEX_KEY);
      this.index = stored && typeof stored === 'object' ? { ...stored } : {};
    }
    return this.index;
  }

  private async saveIndex(index: Record<string, number>): Promise<void> {
    this.index = index;
    try {
      await this.deps.memento.update(BLOB_INDEX_KEY, index);
    } catch (error) {
      this.deps.log?.(`could not persist snapshot index: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
