import { watch, type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';

const MARKER_NAME = 'clear-all-history.json';
const APPLIED_MARKER_KEY = 'editTimelineForCodex.clearAllHistory.applied.v1';
const LEGACY_EXTENSION_ID = 'local-dev.edit-timeline-for-codex';

interface Marker {
  version: 1;
  at: number;
}

/**
 * 用全局标记通知所有已打开窗口；未打开工作区会在下次激活扩展时清除记录索引。
 * 快照正文位于 workspaceStorage，可立即跨工作区删除。
 */
export class AllHistoryCleanup implements vscode.Disposable {
  private watcher: FSWatcher | undefined;
  private queue: Promise<void> = Promise.resolve();
  private watchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly clearLocal: () => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    try {
      this.watcher = watch(this.context.globalStorageUri.fsPath, (_event, filename) => {
        if (filename?.toString().toLowerCase() !== MARKER_NAME) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined;
          void this.enqueue(() => this.applyLatest()).catch((error: unknown) => {
            this.log(`同步全工作区历史清理失败：${describe(error)}`);
          });
        }, 50);
      });
      this.watcher.on('error', (error) => this.log(`监听全工作区历史清理标记失败：${describe(error)}`));
    } catch (error) {
      this.log(`监听全工作区历史清理标记失败：${describe(error)}`);
    }
    await this.enqueue(() => this.applyLatest()).catch((error: unknown) => {
      this.log(`读取全工作区历史清理标记失败：${describe(error)}`);
    });
  }

  async clearAll(): Promise<number> {
    let removed = 0;
    await this.enqueue(async () => {
      const previous = await this.readMarker().catch((error: unknown) => {
        this.log(`读取旧的全工作区历史清理标记失败，将重新创建：${describe(error)}`);
        return undefined;
      });
      const marker: Marker = { version: 1, at: Math.max(Date.now(), (previous?.at ?? 0) + 1) };
      await this.writeMarker(marker);
      await this.apply(marker);
      const storage = this.context.storageUri;
      if (storage) {
        const workspaceStorageRoot = path.dirname(path.dirname(storage.fsPath));
        removed = await clearWorkspaceSnapshotFiles(workspaceStorageRoot, this.context.extension.id);
      }
    });
    return removed;
  }

  dispose(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const task = this.queue.catch(() => {}).then(action);
    this.queue = task;
    return task;
  }

  private async applyLatest(): Promise<void> {
    const marker = await this.readMarker();
    if (marker) await this.apply(marker);
  }

  private async apply(marker: Marker): Promise<void> {
    const applied = this.context.workspaceState.get<number>(APPLIED_MARKER_KEY) ?? 0;
    if (applied >= marker.at) return;
    await this.clearLocal();
    await this.context.workspaceState.update(APPLIED_MARKER_KEY, marker.at);
  }

  private async readMarker(): Promise<Marker | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.context.globalStorageUri.fsPath, MARKER_NAME), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<Marker>;
    if (parsed.version !== 1 || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) {
      throw new Error('全工作区历史清理标记格式无效');
    }
    return parsed as Marker;
  }

  private async writeMarker(marker: Marker): Promise<void> {
    const file = path.join(this.context.globalStorageUri.fsPath, MARKER_NAME);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, 'utf8');
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

export async function clearWorkspaceSnapshotFiles(workspaceStorageRoot: string, currentExtensionId: string): Promise<number> {
  let removed = 0;
  for (const workspace of await directories(workspaceStorageRoot)) {
    for (const extension of await directories(path.join(workspaceStorageRoot, workspace))) {
      if (!isOwnedExtensionDirectory(extension, currentExtensionId)) continue;
      const dataRoot = path.join(workspaceStorageRoot, workspace, extension, 'edit-timeline-for-codex');
      for (const workspaceKey of await directories(dataRoot)) {
        const snapshotDirectory = path.join(dataRoot, workspaceKey, 'snapshots');
        for (const name of await files(snapshotDirectory)) {
          if (!isSnapshotFile(name)) continue;
          await fs.unlink(path.join(snapshotDirectory, name)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          removed += 1;
        }
      }
    }
  }
  return removed;
}

function isOwnedExtensionDirectory(name: string, currentExtensionId: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === currentExtensionId.toLowerCase()
    || normalized === LEGACY_EXTENSION_ID
    || normalized.endsWith('.edit-timeline-for-codex');
}

function isSnapshotFile(name: string): boolean {
  return /^[a-f0-9]{64}$/.test(name) || name === 'index.json' || /^index-.*\.tmp$/.test(name);
}

async function directories(parent: string): Promise<string[]> {
  try {
    return (await fs.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function files(parent: string): Promise<string[]> {
  try {
    return (await fs.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
