import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

describe('真实 Hook 桥接进程', () => {
  let server: net.Server | undefined;
  let descriptor: string | undefined;
  let workspace: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (descriptor) await fs.unlink(descriptor).catch(() => {});
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test('认证后经 Windows 命名管道发送中文与空格路径的 Hook 输入', async () => {
    const id = randomUUID();
    const pipe = `\\\\.\\pipe\\edit-timeline-test-${id}`;
    const token = randomUUID();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-中文 空格-'));
    const directory = path.join(os.tmpdir(), 'edit-timeline-for-codex', 'receivers');
    await fs.mkdir(directory, { recursive: true });
    descriptor = path.join(directory, `${id}.json`);
    let received: unknown;
    server = net.createServer((socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
        if (!input.includes('\n')) return;
        const message = JSON.parse(input.split('\n')[0]);
        expect(message.token).toBe(token);
        received = message.event;
        socket.end('{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve) => server?.listen(pipe, resolve));
    await fs.writeFile(descriptor, JSON.stringify({ pipe, token, roots: [workspace] }), 'utf8');
    const event = { hook_event_name: 'UserPromptSubmit', session_id: '会话 1', turn_id: '回合 1', cwd: workspace, prompt: '修改中文 文件' };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('hook', 'bridge.cjs')], { cwd: workspace });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`bridge exit ${code}`)));
      child.stdin.end(JSON.stringify(event));
    });
    expect(received).toMatchObject(event);
    expect((received as { bridge_started_at: number }).bridge_started_at).toBeTypeOf('number');
  });
});
