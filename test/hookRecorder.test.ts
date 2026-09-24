import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SessionHistoryStore } from '../src/core/historyStore';
import { HookRecorder } from '../src/vscode/hookRecorder';
import type { AISession } from '../src/core/types';
import type { CodexHookEvent } from '../src/vscode/hookReceiver';
import type { Settings } from '../src/vscode/config';

describe('Hook 回合关联', () => {
  let temporary: string;
  let roots: string[];
  let worker: Worker;
  let history: SessionHistoryStore;
  let recorder: HookRecorder;
  let failNextWrite = false;
  let nextId = 0;
  const settings: Settings = {
    maxHistorySessions: 500,
    autoCleanupDays: 30,
    maxSnapshotBytes: 1024 * 1024,
    maxStorageBytes: 512 * 1024 * 1024,
    exclude: [],
    storePrompts: true,
    enableStatistics: false,
    showStatusBar: true,
  };

  function request<T>(method: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const listener = (message: { id: number; result?: T; error?: string }) => {
        if (message.id !== id) return;
        worker.off('message', listener);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result as T);
      };
      worker.on('message', listener);
      worker.postMessage({ id, method, args });
    });
  }

  function event(name: CodexHookEvent['hook_event_name'], turn: string, tool = 'tool'): CodexHookEvent {
    return {
      hook_event_name: name,
      cwd: roots[0],
      session_id: 'session',
      turn_id: turn,
      tool_use_id: tool,
      tool_name: 'Bash',
      tool_input: { command: 'script' },
    };
  }

  beforeEach(async () => {
    settings.maxStorageBytes = 512 * 1024 * 1024;
    failNextWrite = false;
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-recorder-'));
    roots = [path.join(temporary, '项目 一'), path.join(temporary, '项目 二')];
    await Promise.all(roots.map((root) => fs.mkdir(root)));
    worker = new Worker(path.resolve('hook', 'scan-worker.cjs'), { workerData: { storeDir: path.join(temporary, 'snapshots') } });
    const values = new Map<string, unknown>();
    history = new SessionHistoryStore({
      memento: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key, value) => {
          if (failNextWrite) { failNextWrite = false; throw new Error('模拟历史提交失败'); }
          values.set(key, structuredClone(value));
        },
      },
      now: () => Date.now(),
      settings: () => settings,
      releaseRefs: async () => {},
    });
    recorder = new HookRecorder(roots, { request }, history, () => settings, async (refs) => request('reconcile', { refs }), () => {});
  });

  afterEach(async () => {
    await worker.terminate();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  test('提示词不扫描，并按两个工作区分别提交', async () => {
    const a = path.join(roots[0], 'a.txt');
    const b = path.join(roots[1], 'b.txt');
    await fs.writeFile(a, 'before a', 'utf8');
    await fs.writeFile(b, 'before b', 'utf8');
    await recorder.handle({ ...event('UserPromptSubmit', 'turn-1'), prompt: '修改两个工作区' });
    expect((await request<{ scans: number }>('metrics', {})).scans).toBe(0);
    await recorder.handle(event('PreToolUse', 'turn-1'));
    await fs.writeFile(a, 'after a', 'utf8');
    await fs.writeFile(b, 'after b', 'utf8');
    await recorder.handle(event('PostToolUse', 'turn-1'));
    const sessions = await history.all();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((item) => item.workspaceRoot).sort()).toEqual([...roots].sort());
    expect(sessions.every((item) => item.prompt === '修改两个工作区')).toBe(true);
    await recorder.handle(event('PostToolUse', 'turn-1'));
    expect(await history.all()).toHaveLength(2);
  });

  test('重叠回合独立关联，并标记无法区分的并发改动', async () => {
    const a = path.join(roots[0], 'a.txt');
    const b = path.join(roots[0], 'b.txt');
    await fs.writeFile(a, 'a0', 'utf8');
    await fs.writeFile(b, 'b0', 'utf8');
    await recorder.handle(event('PreToolUse', 'turn-1', 'tool-1'));
    await recorder.handle(event('PreToolUse', 'turn-2', 'tool-2'));
    expect(recorder.activeTurns()).toHaveLength(4);
    await fs.writeFile(a, 'a1', 'utf8');
    await recorder.handle(event('PostToolUse', 'turn-1', 'tool-1'));
    await fs.writeFile(b, 'b1', 'utf8');
    await recorder.handle(event('PostToolUse', 'turn-2', 'tool-2'));
    const sessions = (await history.all()).filter((item) => item.workspaceRoot === roots[0]);
    expect(sessions.map((item) => item.turnId).sort()).toEqual(['turn-1', 'turn-2']);
    expect(sessions.every((item) => item.attributionUncertain)).toBe(true);
    expect(recorder.activeTurns()).toHaveLength(0);
  });

  test('单工具回合从工具前回调计时', async () => {
    const file = path.join(roots[0], 'duration.txt');
    await fs.writeFile(file, 'before', 'utf8');
    await recorder.handle(event('PreToolUse', 'duration-turn'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fs.writeFile(file, 'after', 'utf8');
    await recorder.handle(event('PostToolUse', 'duration-turn'));
    const session = (await history.all()).find((item) => item.workspaceRoot === roots[0]);
    expect(session?.duration).toBeGreaterThanOrEqual(25);
    expect(session?.duration).toBe(session!.endedAt! - session!.startedAt);
  });

  test('容量紧张且新历史提交失败时保留旧记录与快照', async () => {
    const oldRef = await request<string>('put', { text: randomBytes(4096).toString('hex'), limitBytes: 1024 * 1024 });
    const at = Date.now() - 1000;
    const old: AISession = {
      id: 'old', startedAt: at, endedAt: at, ai: 'codex', detection: 'api', duration: 0,
      files: [{ path: 'old.txt', workspaceRoot: roots[0], kind: 'change', beforeRef: oldRef, afterRef: oldRef, snapshot: 'captured', added: 0, deleted: 0 }],
      stats: { added: 0, deleted: 0 },
    };
    await history.append(old);
    const used = await request<number>('usage', {});
    settings.maxStorageBytes = used + 100;
    const file = path.join(roots[0], 'new.txt');
    await fs.writeFile(file, 'before', 'utf8');
    await recorder.handle(event('PreToolUse', 'new-turn'));
    await fs.writeFile(file, 'after', 'utf8');
    failNextWrite = true;
    await expect(recorder.handle(event('PostToolUse', 'new-turn'))).rejects.toThrow('模拟历史提交失败');
    expect((await history.all()).map((session) => session.id)).toEqual(['old']);
    expect(await request('get', { ref: oldRef })).toBeDefined();
  });

  test('清理与采集交错时仍保留已提交记录引用', async () => {
    const file = path.join(roots[0], 'concurrent.txt');
    await fs.writeFile(file, 'before', 'utf8');
    await recorder.handle(event('PreToolUse', 'cleanup-turn'));
    const beforeCleanup = recorder.maintenance(async () => {
      await history.prune();
      await request('reconcile', { refs: [] });
    });
    await fs.writeFile(file, 'after', 'utf8');
    const capture = recorder.handle(event('PostToolUse', 'cleanup-turn'));
    const afterCleanup = recorder.maintenance(async () => {
      const refs = (await history.all()).flatMap((session) => session.files.flatMap((change) => [change.beforeRef, change.afterRef].filter((ref): ref is string => Boolean(ref))));
      await request('reconcile', { refs });
    });
    await Promise.all([beforeCleanup, capture, afterCleanup]);
    const recorded = (await history.all()).find((session) => session.workspaceRoot === roots[0]);
    expect(recorded?.files).toHaveLength(1);
    expect(await request('get', { ref: recorded?.files[0].beforeRef })).toBe('before');
    expect(await request('get', { ref: recorded?.files[0].afterRef })).toBe('after');
  });
});
