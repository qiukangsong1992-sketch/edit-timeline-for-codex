import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

interface FileResult { path: string; kind: string; beforeRef?: string; afterRef?: string; snapshot: string; reason?: string }
interface ScanResult { files: FileResult[]; complete: boolean }

describe('Hook 扫描 worker', () => {
  let temporary: string;
  let root: string;
  let storeDir: string;
  let worker: Worker;
  let nextId = 0;
  const settings = {
    maxSnapshotBytes: 1024,
    maxStorageBytes: 1024 * 1024,
    exclude: ['**/node_modules/**', '**/dist/**'],
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

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-worker-'));
    root = path.join(temporary, '中文 空格 project');
    storeDir = path.join(temporary, 'snapshots');
    await fs.mkdir(root);
    worker = new Worker(path.resolve('hook', 'scan-worker.cjs'), { workerData: { storeDir } });
  });

  afterEach(async () => {
    await worker.terminate();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  test('补丁目标不枚举工作区，并记录移动两端', async () => {
    const oldFile = path.join(root, '旧 文件.txt');
    const newFile = path.join(root, '新 文件.txt');
    await fs.writeFile(oldFile, '原内容', 'utf8');
    await request('pre', { root, key: 'move', targets: [oldFile, newFile], settings, budgetMs: 10000 });
    await fs.rename(oldFile, newFile);
    const result = await request<ScanResult>('post', { root, key: 'move', targets: [oldFile, newFile], settings, budgetMs: 10000 });
    expect(result.files.map((file) => [file.path, file.kind]).sort()).toEqual([['旧 文件.txt', 'delete'], ['新 文件.txt', 'create']].sort());
    const metrics = await request<{ enumeratedFiles: number; bodyReads: number }>('metrics', {});
    expect(metrics.enumeratedFiles).toBe(0);
    expect(metrics.bodyReads).toBeLessThanOrEqual(2);
    const deleted = result.files.find((file) => file.kind === 'delete');
    expect(await request('get', { ref: deleted?.beforeRef })).toBe('原内容');
  });

  test('通用扫描重新枚举增删文件，复用未变化正文，默认保留锁文件和文档', async () => {
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), '忽略', 'utf8');
    await fs.writeFile(path.join(root, 'package-lock.json'), '锁文件', 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), '说明', 'utf8');
    await fs.writeFile(path.join(root, 'remove.txt'), '删除', 'utf8');
    await request('pre', { root, key: 'shell', settings, budgetMs: 10000 });
    await fs.writeFile(path.join(root, 'README.md'), '新说明', 'utf8');
    await fs.unlink(path.join(root, 'remove.txt'));
    await fs.writeFile(path.join(root, 'added.txt'), '新增', 'utf8');
    const result = await request<ScanResult>('post', { root, key: 'shell', settings, budgetMs: 10000 });
    expect(result.files.map((file) => file.path).sort()).toEqual(['README.md', 'added.txt', 'remove.txt']);
    expect(result.files.every((file) => file.snapshot === 'captured')).toBe(true);
    const metrics = await request<{ bodyReads: number; enumeratedFiles: number }>('metrics', {});
    expect(metrics.bodyReads).toBe(5);
    expect(metrics.enumeratedFiles).toBe(6);
  });

  test('相同正文共享哈希，引用计数按实际次数重建并清理孤立快照', async () => {
    const ref = await request<string>('put', { text: '共享', limitBytes: 1024 * 1024 });
    expect(await request('put', { text: '共享', limitBytes: 1024 * 1024 })).toBe(ref);
    expect(await request('reconcile', { refs: [ref, ref] })).toEqual({ [ref]: 2 });
    expect(await request('get', { ref })).toBe('共享');
    expect(JSON.parse(await fs.readFile(path.join(storeDir, 'index.json'), 'utf8'))[ref]).toBe(2);
    await request('reconcile', { refs: [] });
    expect(await request('get', { ref })).toBeUndefined();
  });

  test('快照读取只接受内容哈希引用', async () => {
    expect(await request('get', { ref: '../index.json' })).toBeUndefined();
  });

  test('缺少修改前快照与容量不足明确降级', async () => {
    const file = path.join(root, 'large.txt');
    await fs.writeFile(file, '内容', 'utf8');
    const missing = await request<ScanResult>('post', { root, key: 'late', targets: [file], settings, budgetMs: 10000 });
    expect(missing.complete).toBe(false);
    expect(missing.files[0].reason).toBe('缺少修改前快照');
    await request('pre', { root, key: 'tiny', targets: [file], settings, budgetMs: 10000 });
    await fs.writeFile(file, '新内容', 'utf8');
    const tiny = await request<ScanResult>('post', { root, key: 'tiny', targets: [file], settings: { ...settings, maxStorageBytes: 1 }, budgetMs: 10000 });
    expect(tiny.files[0].snapshot).toBe('unavailable');
    expect(tiny.files[0].reason).toContain('容量不足');
  });

  test('超过 24 小时的工具前像被淘汰', async () => {
    await request('pre', { root, key: 'stale', targets: [], settings, budgetMs: 10000 });
    expect(await request('expire', { now: Date.now() + 86400001 })).toBe(0);
  });

  test('空闲时不扫描工作区', async () => {
    const before = await request<{ scans: number }>('metrics', {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = await request<{ scans: number }>('metrics', {});
    expect(after.scans).toBe(before.scans);
  });

  test('磁盘写入失败作为采集错误上报，不误标为二进制文件', async () => {
    await worker.terminate();
    await fs.writeFile(storeDir, '占位文件', 'utf8');
    worker = new Worker(path.resolve('hook', 'scan-worker.cjs'), { workerData: { storeDir } });
    const file = path.join(root, 'write-failure.txt');
    await fs.writeFile(file, '文本内容', 'utf8');
    await expect(request('pre', { root, key: 'failed', targets: [file], settings, budgetMs: 10000 })).rejects.toThrow();
  });

  test('重启后按真实历史引用恢复计数并删除崩溃孤立文件', async () => {
    const live = await request<string>('put', { text: '仍在历史中', limitBytes: 1024 * 1024 });
    const orphan = await request<string>('put', { text: '未完成提交', limitBytes: 1024 * 1024 });
    await worker.terminate();
    worker = new Worker(path.resolve('hook', 'scan-worker.cjs'), { workerData: { storeDir } });
    expect(await request('reconcile', { refs: [live, live] })).toEqual({ [live]: 2 });
    expect(await request('get', { ref: live })).toBe('仍在历史中');
    expect(await request('get', { ref: orphan })).toBeUndefined();
  });
});
