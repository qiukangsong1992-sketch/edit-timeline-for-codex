import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AllHistoryCleanup, clearWorkspaceSnapshotFiles } from '../src/vscode/allHistoryCleanup';

describe('全工作区快照清理', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-clear-all-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('清理当前和旧发布者的快照，同时保留其他扩展文件', async () => {
    const current = path.join(root, 'workspace-1', 'karson1992.edit-timeline-for-codex', 'edit-timeline-for-codex', 'key-1', 'snapshots');
    const legacy = path.join(root, 'workspace-2', 'local-dev.edit-timeline-for-codex', 'edit-timeline-for-codex', 'key-2', 'snapshots');
    const unrelated = path.join(root, 'workspace-3', 'someone.other-extension', 'edit-timeline-for-codex', 'key-3', 'snapshots');
    await Promise.all([current, legacy, unrelated].map((directory) => fs.mkdir(directory, { recursive: true })));
    const hash = 'a'.repeat(64);
    await fs.writeFile(path.join(current, hash), 'current');
    await fs.writeFile(path.join(current, 'index.json'), '{}');
    await fs.writeFile(path.join(current, 'keep.txt'), 'keep');
    await fs.writeFile(path.join(legacy, hash), 'legacy');
    await fs.writeFile(path.join(unrelated, hash), 'unrelated');

    expect(await clearWorkspaceSnapshotFiles(root, 'karson1992.edit-timeline-for-codex')).toBe(3);
    await expect(fs.stat(path.join(current, hash))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(legacy, hash))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(current, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(unrelated, hash), 'utf8')).toBe('unrelated');
  });

  test('全局标记让未打开工作区在下次激活时清空索引', async () => {
    const globalStorage = path.join(root, 'globalStorage');
    const workspaceStorage = path.join(root, 'workspaceStorage');
    await fs.mkdir(globalStorage, { recursive: true });
    const firstState = new Map<string, unknown>();
    const secondState = new Map<string, unknown>();
    let firstClears = 0;
    let secondClears = 0;
    const first = new AllHistoryCleanup(
      fakeContext(globalStorage, path.join(workspaceStorage, 'one', 'karson1992.edit-timeline-for-codex'), firstState),
      async () => { firstClears += 1; },
      () => {},
    );
    const second = new AllHistoryCleanup(
      fakeContext(globalStorage, path.join(workspaceStorage, 'two', 'karson1992.edit-timeline-for-codex'), secondState),
      async () => { secondClears += 1; },
      () => {},
    );
    try {
      await first.start();
      await first.clearAll();
      await first.clearAll();
      expect(firstClears).toBe(2);

      await second.start();
      expect(secondClears).toBe(1);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

function fakeContext(globalStorage: string, storage: string, state: Map<string, unknown>): vscode.ExtensionContext {
  return {
    extension: { id: 'karson1992.edit-timeline-for-codex' },
    globalStorageUri: { fsPath: globalStorage },
    storageUri: { fsPath: storage },
    workspaceState: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
  } as unknown as vscode.ExtensionContext;
}
