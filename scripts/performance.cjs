'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-perf-'));
  const root = path.join(temporary, 'workspace');
  const storeDir = path.join(temporary, 'snapshots');
  await fs.mkdir(root);
  let worker;
  let nextId = 0;
  let maxLoopDelay = 0;
  let lastTick = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    maxLoopDelay = Math.max(maxLoopDelay, now - lastTick - 50);
    lastTick = now;
  }, 50);
  try {
    const body = `${'abcdefghijklmnopqrstuvwxyz0123456789\n'.repeat(276)}`.slice(0, 10240);
    for (let dir = 0; dir < 100; dir++) {
      const folder = path.join(root, `group-${String(dir).padStart(3, '0')}`);
      await fs.mkdir(folder);
      await Promise.all(Array.from({ length: 100 }, (_, file) => fs.writeFile(path.join(folder, `file-${String(file).padStart(3, '0')}.txt`), `${dir}:${file}\n${body}`, 'utf8')));
    }
    worker = new Worker(path.join(__dirname, '..', 'hook', 'scan-worker.cjs'), { workerData: { storeDir } });
    const request = (method, args) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const listener = (message) => {
        if (message.id !== id) return;
        worker.off('message', listener);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      };
      worker.on('message', listener);
      worker.postMessage({ id, method, args });
    });
    const settings = { maxSnapshotBytes: 1048576, maxStorageBytes: 536870912, exclude: [] };
    const coldStart = performance.now();
    let cold;
    try { await request('pre', { root, key: 'cold', settings, budgetMs: 10000 }); cold = { ms: Math.round(performance.now() - coldStart), complete: true }; }
    catch (error) { cold = { ms: Math.round(performance.now() - coldStart), complete: false, reason: error.message }; }
    if (!cold.complete) await request('pre', { root, key: 'prime', settings, budgetMs: 120000 });
    await request('post', { root, key: cold.complete ? 'cold' : 'prime', settings, budgetMs: 120000 });
    await request('resetMetrics', {});
    const warmStart = performance.now();
    await request('pre', { root, key: 'warm', settings, budgetMs: 10000 });
    const warmPreMs = Math.round(performance.now() - warmStart);
    const target = path.join(root, 'group-000', 'file-000.txt');
    await fs.appendFile(target, 'changed\n');
    const warmPostStart = performance.now();
    await request('post', { root, key: 'warm', settings, budgetMs: 10000 });
    const warmPostMs = Math.round(performance.now() - warmPostStart);
    const warmMetrics = await request('metrics', {});
    await request('resetMetrics', {});
    const patchStart = performance.now();
    await request('pre', { root, key: 'patch', targets: [target], settings, budgetMs: 10000 });
    const patchPreMs = Math.round(performance.now() - patchStart);
    await fs.appendFile(target, 'patch\n');
    const patchPostStart = performance.now();
    await request('post', { root, key: 'patch', targets: [target], settings, budgetMs: 10000 });
    const patchPostMs = Math.round(performance.now() - patchPostStart);
    const patchMetrics = await request('metrics', {});
    await request('resetMetrics', {});
    const continuousStart = performance.now();
    for (let index = 0; index < 10; index++) {
      await request('pre', { root, key: `continuous-${index}`, targets: [target], settings, budgetMs: 10000 });
      await fs.appendFile(target, `${index}\n`);
      await request('post', { root, key: `continuous-${index}`, targets: [target], settings, budgetMs: 10000 });
    }
    const continuousMetrics = await request('metrics', {});
    console.log(JSON.stringify({ validFiles: 10000, approximateTextBytes: 102400000, cold, warm: { preMs: warmPreMs, postMs: warmPostMs, metrics: warmMetrics }, patch: { preMs: patchPreMs, postMs: patchPostMs, metrics: patchMetrics }, continuous: { tools: 10, totalMs: Math.round(performance.now() - continuousStart), metrics: continuousMetrics }, hostLoopMaxDelayMs: Math.round(maxLoopDelay) }, null, 2));
  } finally {
    clearInterval(loop);
    if (worker) await worker.terminate();
    const base = path.resolve(os.tmpdir());
    if (!path.resolve(temporary).startsWith(`${base}${path.sep}`)) throw new Error('temporary path escaped temp directory');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
