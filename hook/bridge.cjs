'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const directory = path.join(os.tmpdir(), 'edit-timeline-for-codex', 'receivers');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function receivers(cwd) {
  let names;
  try { names = fs.readdirSync(directory); } catch { return []; }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    try {
      const descriptor = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      return Array.isArray(descriptor.roots) && descriptor.roots.some((root) => within(root, cwd))
        ? [descriptor] : [];
    } catch { return []; }
  });
}

function send(receiver, event) {
  return new Promise((resolve) => {
    const socket = net.createConnection(receiver.pipe);
    let reply = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 12000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: receiver.token, event })}\n`));
    socket.on('data', (chunk) => {
      reply += chunk;
      if (reply.includes('\n')) {
        clearTimeout(timer);
        socket.end();
        try { resolve(JSON.parse(reply.split('\n')[0]).ok === true); } catch { resolve(false); }
      }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
    socket.on('close', () => { clearTimeout(timer); resolve(false); });
  });
}

async function main() {
  const startedAt = Date.now();
  if (process.argv.includes('--self-test')) {
    process.stdout.write('ok\n');
    return;
  }
  if (process.argv.includes('--pipe-self-test')) {
    const results = await Promise.all(receivers(process.cwd()).map((receiver) => send(receiver, { hook_event_name: '__ping', cwd: process.cwd() })));
    if (!results.some(Boolean)) throw new Error('命名管道自检失败');
    process.stdout.write('ok\n');
    return;
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8 * 1024 * 1024) return;
  }
  let event;
  try { event = JSON.parse(input); } catch { return; }
  event.bridge_started_at = startedAt;
  const cwd = typeof event.cwd === 'string' ? path.resolve(event.cwd) : process.cwd();
  await Promise.all(receivers(cwd).map((receiver) => send(receiver, event)));
}

if (require.main === module) {
  main().catch((error) => process.stderr.write(`Edit Timeline For Codex: ${error.message}\n`));
}

module.exports = { main, receivers, send };
