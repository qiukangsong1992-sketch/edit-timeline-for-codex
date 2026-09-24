'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');

const pending = new Map();
const caches = new Map();
const bodyCache = new Map();
const statsCache = new Map();
let bodyBytes = 0;
const BODY_LIMIT = 64 * 1024 * 1024;
const storeDir = workerData.storeDir;
const activeReads = new Set();
let writeQueue = Promise.resolve();
let blobQueue = Promise.resolve();
let usedBytes;
const metrics = { scans: 0, enumeratedFiles: 0, bodyReads: 0, bodyBytesRead: 0 };

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function excluded(relative, patterns) {
  const normalized = relative.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return patterns.some((pattern) => {
    const directory = /^\*\*\/([^*]+)\/\*\*$/.exec(pattern);
    if (directory) return parts.includes(directory[1]);
    const raw = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    if (!raw.includes('*')) return parts.includes(raw) || normalized === raw;
    const regex = new RegExp(`^${raw.split('**').map((segment) => segment.split('*').map(escapeRegex).join('[^/]*')).join('.*')}$`);
    return pattern.startsWith('**/') ? parts.some((_, index) => regex.test(parts.slice(index).join('/'))) : regex.test(normalized);
  });
}

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function rememberBody(key, text) {
  if (bodyCache.has(key)) {
    bodyBytes -= Buffer.byteLength(bodyCache.get(key), 'utf8');
    bodyCache.delete(key);
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > BODY_LIMIT) return;
  bodyCache.set(key, text);
  bodyBytes += size;
  while (bodyBytes > BODY_LIMIT) {
    const oldest = bodyCache.keys().next().value;
    bodyBytes -= Buffer.byteLength(bodyCache.get(oldest), 'utf8');
    bodyCache.delete(oldest);
  }
}

async function readLimited(file) {
  while (activeReads.size >= 4) await Promise.race(activeReads);
  const operation = fs.readFile(file);
  activeReads.add(operation);
  try {
    const bytes = await operation;
    metrics.bodyReads++;
    metrics.bodyBytesRead += bytes.length;
    return bytes;
  } finally { activeReads.delete(operation); }
}

async function snapshot(root, absolute, maxBytes, maxStorageBytes, force) {
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  let stat;
  try { stat = await fs.stat(absolute); } catch (error) {
    if (error.code === 'ENOENT') return { path: relative, exists: false };
    throw error;
  }
  if (!stat.isFile()) return { path: relative, exists: true, reason: '非普通文件' };
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cache = caches.get(root) || new Map();
  caches.set(root, cache);
  const previous = cache.get(relative);
  if (!force && previous?.identity === identity && previous.ref) return previous;
  const result = { path: relative, exists: true, size: stat.size, identity };
  if (stat.size > maxBytes) {
    result.reason = '文件超过快照大小上限';
  } else {
    const cached = force ? undefined : bodyCache.get(`${root}:${relative}:${identity}`);
    const bytes = cached === undefined ? await readLimited(absolute) : undefined;
    let text = cached;
    if (text === undefined) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { result.reason = '二进制文件'; }
    }
    if (text !== undefined) {
      if (text.includes('\0')) result.reason = '二进制文件';
      else {
        result.hash = createHash('sha256').update(text, 'utf8').digest('hex');
        result.ref = await put(text, maxStorageBytes);
        if (cached === undefined) rememberBody(`${root}:${relative}:${identity}`, text);
      }
    }
  }
  cache.set(relative, result);
  return result;
}

async function enumerate(root, patterns, deadline) {
  const files = [];
  const dirs = [root];
  while (dirs.length) {
    if (Date.now() > deadline) throw new Error('采集超时');
    const dir = dirs.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (excluded(relative, patterns)) continue;
      if (entry.isDirectory()) dirs.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  metrics.enumeratedFiles += files.length;
  return files;
}

async function scan(root, targets, settings, deadline) {
  metrics.scans++;
  const maxBytes = settings.maxSnapshotBytes || 1048576;
  const paths = targets ? [] : await enumerate(root, settings.exclude || [], deadline);
  if (targets) {
    const realRoot = await fs.realpath(root);
    for (const target of targets) {
      if (!inside(root, target) || excluded(path.relative(root, target), settings.exclude || [])) continue;
      let existing = target;
      while (true) {
        try { await fs.lstat(existing); break; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const parent = path.dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
      }
      const realExisting = await fs.realpath(existing);
      if (inside(realRoot, realExisting)) paths.push(target);
    }
  }
  const output = new Map();
  for (let index = 0; index < paths.length; index += 4) {
    if (Date.now() > deadline) throw new Error('采集超时');
    const group = await Promise.all(paths.slice(index, index + 4).map((absolute) => snapshot(root, absolute, maxBytes, settings.maxStorageBytes, Boolean(targets))));
    for (const entry of group) output.set(entry.path, entry);
  }
  return output;
}

function put(text, limitBytes) {
  const operation = blobQueue.then(() => writeBlob(text, limitBytes));
  blobQueue = operation.catch(() => {});
  return operation;
}

async function writeBlob(text, limitBytes) {
  if (text === undefined) return undefined;
  const ref = createHash('sha256').update(text, 'utf8').digest('hex');
  const file = path.join(storeDir, ref);
  try { await fs.access(file); return ref; } catch { /* new content */ }
  const compressed = gzipSync(Buffer.from(text, 'utf8'));
  await diskUsage();
  if (usedBytes + compressed.length > limitBytes) return undefined;
  await fs.mkdir(storeDir, { recursive: true });
  try { await fs.writeFile(file, compressed, { flag: 'wx' }); usedBytes += compressed.length; } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return ref;
}

async function diskUsage() {
  if (usedBytes === undefined) {
    usedBytes = 0;
    for (const name of await fs.readdir(storeDir).catch(() => [])) {
      if (/^[a-f0-9]{64}$/.test(name)) usedBytes += (await fs.stat(path.join(storeDir, name))).size;
    }
  }
  return usedBytes;
}

async function reconcile(refs) {
  const counts = new Map();
  const allRefs = [...refs];
  for (const cache of caches.values()) for (const image of cache.values()) if (image.ref) allRefs.push(image.ref);
  for (const tool of pending.values()) for (const image of tool.images.values()) if (image.ref) allRefs.push(image.ref);
  for (const ref of allRefs) counts.set(ref, (counts.get(ref) || 0) + 1);
  await fs.mkdir(storeDir, { recursive: true });
  const names = await fs.readdir(storeDir);
  for (const name of names) {
    if (/^[a-f0-9]{64}$/.test(name) && !counts.has(name)) await fs.unlink(path.join(storeDir, name)).catch(() => {});
  }
  usedBytes = 0;
  for (const name of await fs.readdir(storeDir)) {
    if (/^[a-f0-9]{64}$/.test(name)) usedBytes += (await fs.stat(path.join(storeDir, name))).size;
  }
  const temporary = path.join(storeDir, `index-${process.pid}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(counts)), 'utf8');
  await fs.rename(temporary, path.join(storeDir, 'index.json'));
  return Object.fromEntries(counts);
}

async function handle(method, args) {
  if (method === 'metrics') return { ...metrics, workerHeapBytes: process.memoryUsage().heapUsed, pendingTools: pending.size };
  if (method === 'resetMetrics') {
    metrics.scans = 0;
    metrics.enumeratedFiles = 0;
    metrics.bodyReads = 0;
    metrics.bodyBytesRead = 0;
    return true;
  }
  if (method === 'prompt') return true;
  if (method === 'evictCache') {
    caches.clear();
    bodyCache.clear();
    bodyBytes = 0;
    return true;
  }
  if (method === 'pre') {
    const deadline = Date.now() + args.budgetMs;
    const images = await scan(args.root, args.targets, args.settings, deadline);
    pending.set(args.key, { root: args.root, images, at: Date.now(), targets: args.targets });
    return { count: images.size };
  }
  if (method === 'post') {
    const staged = pending.get(args.key);
    pending.delete(args.key);
    if (!staged && !args.targets) return { files: [], complete: false, at: Date.now() };
    const deadline = Date.now() + args.budgetMs;
    const after = await scan(args.root, staged?.targets ?? args.targets, args.settings, deadline);
    const before = staged?.images || new Map();
    const paths = new Set([...before.keys(), ...after.keys()]);
    const files = [];
    for (const relative of paths) {
      if (Date.now() > deadline) throw new Error('采集超时');
      const a = before.get(relative) || { exists: false };
      const b = after.get(relative) || { exists: false };
      if (!a.exists && !b.exists) continue;
      if (!staged) {
        files.push({ path: relative, kind: b.exists ? 'change' : 'delete', snapshot: 'unavailable', reason: '缺少修改前快照', added: 0, deleted: 0 });
        continue;
      }
      if (a.exists === b.exists && a.hash !== undefined && a.hash === b.hash) continue;
      if (a.exists === b.exists && a.identity === b.identity && a.hash === b.hash) continue;
      const kind = !a.exists ? 'create' : !b.exists ? 'delete' : 'change';
      const beforeRef = a.exists ? a.ref : await put('', args.settings.maxStorageBytes);
      const afterRef = b.exists ? b.ref : undefined;
      const reason = !staged ? '缺少修改前快照' : a.reason || b.reason || (!beforeRef || (b.exists && !afterRef) ? '容量不足或快照不可用' : undefined);
      const snapshotState = a.reason === '二进制文件' || b.reason === '二进制文件'
        ? 'binary' : a.reason === '文件超过快照大小上限' || b.reason === '文件超过快照大小上限'
          ? 'too-large' : !staged || !beforeRef || (b.exists && !afterRef) ? 'unavailable' : 'captured';
      files.push({ path: relative, kind, beforeRef, afterRef, snapshot: snapshotState, reason, added: 0, deleted: 0 });
    }
    return { files, complete: Boolean(staged), at: Date.now() };
  }
  if (method === 'get') {
    if (typeof args.ref !== 'string' || !/^[a-f0-9]{64}$/.test(args.ref)) return undefined;
    try { return gunzipSync(await fs.readFile(path.join(storeDir, args.ref))).toString('utf8'); } catch { return undefined; }
  }
  if (method === 'stats') {
    const key = `${args.beforeRef || ''}:${args.afterRef || ''}`;
    if (statsCache.has(key)) return statsCache.get(key);
    const before = args.beforeRef ? await handle('get', { ref: args.beforeRef }) : '';
    const after = args.afterRef ? await handle('get', { ref: args.afterRef }) : '';
    if (before === undefined || after === undefined) return { added: 0, deleted: 0 };
    const oldLines = before ? before.split(/\r?\n/).filter((line, index, lines) => index < lines.length - 1 || line !== '') : [];
    const newLines = after ? after.split(/\r?\n/).filter((line, index, lines) => index < lines.length - 1 || line !== '') : [];
    let common = 0;
    if (oldLines.length * newLines.length <= 4000000) {
      let previous = new Uint32Array(newLines.length + 1);
      for (const line of oldLines) {
        const current = new Uint32Array(newLines.length + 1);
        for (let i = 0; i < newLines.length; i++) current[i + 1] = line === newLines[i] ? previous[i] + 1 : Math.max(previous[i + 1], current[i]);
        previous = current;
      }
      common = previous[newLines.length];
    }
    const result = { added: newLines.length - common, deleted: oldLines.length - common };
    statsCache.set(key, result);
    if (statsCache.size > 1000) statsCache.delete(statsCache.keys().next().value);
    return result;
  }
  if (method === 'put') return put(args.text, args.limitBytes);
  if (method === 'usage') return diskUsage();
  if (method === 'reconcile') return reconcile(args.refs);
  if (method === 'expire') {
    const now = args.now || Date.now();
    for (const [key, value] of pending) if (now - value.at > 86400000) pending.delete(key);
    return pending.size;
  }
  throw new Error(`Unknown worker method: ${method}`);
}

parentPort.on('message', ({ id, method, args }) => {
  const operation = writeQueue.then(() => handle(method, args));
  writeQueue = operation.catch(() => {});
  operation.then((result) => parentPort.postMessage({ id, result }), (error) => parentPort.postMessage({ id, error: error.message }));
});

setInterval(() => {
  for (const [key, value] of pending) if (Date.now() - value.at > 86400000) pending.delete(key);
}, 1800000).unref();
