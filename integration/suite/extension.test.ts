import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditTimelineForCodexApi } from '../../src/extension';

const EXTENSION_ID = 'local-dev.edit-timeline-for-codex';
let api: EditTimelineForCodexApi;
let extension: vscode.Extension<EditTimelineForCodexApi>;

function workspace(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  return folder.uri;
}

async function sendHook(event: Record<string, unknown>): Promise<{ bridgeMs: number; settledMs: number }> {
  const bridge = path.join(extension.extensionPath, 'hook', 'bridge.cjs');
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      cwd: workspace().fsPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`桥接进程退出 ${code}：${stderr}`)));
    child.stdin.end(JSON.stringify({ cwd: workspace().fsPath, ...event }));
  });
  const bridgeMs = Date.now() - started;
  await api.settled();
  return { bridgeMs, settledMs: Date.now() - started };
}

function event(name: string, session: string, turn: string, tool = 'tool-1'): Record<string, unknown> {
  return {
    hook_event_name: name,
    session_id: session,
    turn_id: turn,
    tool_use_id: tool,
    tool_name: 'Bash',
    tool_input: { command: 'run a script' },
  };
}

async function write(file: string, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace(), file), new TextEncoder().encode(text));
}

async function remove(file: string): Promise<void> {
  try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspace(), file), { useTrash: false }); } catch { /* absent */ }
}

suite('Edit Timeline For Codex 扩展集成', () => {
  suiteSetup(async () => {
    const found = vscode.extensions.getExtension<EditTimelineForCodexApi>(EXTENSION_ID);
    assert.ok(found, `${EXTENSION_ID} 未加载`);
    extension = found;
    const activated = await extension.activate();
    assert.ok(activated);
    api = activated;
  });

  test('注册命令并公开版本化 API', async () => {
    assert.equal(api.version, 1);
    assert.equal(typeof api.getActiveTurns, 'function');
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed = extension.packageJSON.contributes.commands as { command: string }[];
    assert.deepEqual(contributed.filter((item) => !registered.has(item.command)), []);
  });

  test('没有 Hook 时人工保存不生成记录', async () => {
    const file = '人工保存-空格 file.txt';
    const before = (await api.getSessions()).length;
    await write(file, '仅人工保存');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await api.getSessions()).length, before);
    await remove(file);
  });

  test('真实桥接进程采集提示词、增删改、失败工具和重复回调', async () => {
    const session = randomUUID();
    const turn = randomUUID();
    const changed = '中文 空格-修改.txt';
    const deleted = '中文 空格-删除.txt';
    const created = '中文 空格-新增.txt';
    await remove(created);
    await write(changed, '修改前\n');
    await write(deleted, '删除前\n');
    await sendHook({ ...event('UserPromptSubmit', session, turn), prompt: '请修改这三个文件' });
    await sendHook(event('PreToolUse', session, turn));
    await write(changed, '修改后\n');
    await remove(deleted);
    await write(created, '新增内容\n');
    await sendHook({ ...event('PostToolUse', session, turn), tool_response: { exit_code: 1 } });
    const records = (await api.getSessions()).filter((item) => item.codexSessionId === session);
    assert.equal(records.length, 1);
    assert.ok(records[0].duration > 0, '单工具回合应记录工具前到工具后的采集跨度');
    assert.equal(records[0].prompt, '请修改这三个文件');
    assert.deepEqual(records[0].files.map((file) => [file.path, file.kind]).sort(), [
      [changed, 'change'], [created, 'create'], [deleted, 'delete'],
    ].sort());
    const modified = records[0].files.find((file) => file.path === changed);
    assert.ok(modified?.beforeRef);
    assert.equal(await api.getSnapshot(modified.beforeRef), '修改前\n');
    await sendHook(event('PostToolUse', session, turn));
    assert.equal((await api.getSessions()).filter((item) => item.codexSessionId === session).length, 1);
    await remove(changed);
    await remove(created);
  });

  test('创建文件可恢复并撤销恢复', async () => {
    const session = randomUUID();
    const turn = randomUUID();
    const file = '恢复 空格.txt';
    await remove(file);
    await sendHook(event('PreToolUse', session, turn));
    await write(file, '恢复目标');
    await sendHook(event('PostToolUse', session, turn));
    const entry = (await api.getSessions()).find((item) => item.codexSessionId === session);
    assert.ok(entry);
    assert.equal(entry.files.find((item) => item.path === file)?.snapshot, 'captured');
    const restored = await api.restoreFile(entry.id, file);
    assert.deepEqual(restored.restored, [file]);
    await assert.rejects(async () => vscode.workspace.fs.stat(vscode.Uri.joinPath(workspace(), file)));
    const undo = (await api.getSessions()).find((item) => item.ai === 'manual' && item.files.some((item) => item.path === file));
    assert.ok(undo);
    const undone = await api.restoreSession(undo.id);
    assert.deepEqual(undone.restored, [file]);
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace(), file))), '恢复目标');
    await remove(file);
  });

  test('多根工作区路由到实际被修改的根目录', async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    assert.equal(folders.length, 2);
    const second = folders[1].uri;
    const file = '第二根目录.txt';
    const uri = vscode.Uri.joinPath(second, file);
    const session = randomUUID();
    const turn = randomUUID();
    await sendHook(event('PreToolUse', session, turn));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('来自第二根目录'));
    await sendHook(event('PostToolUse', session, turn));
    const entry = (await api.getSessions()).find((item) => item.codexSessionId === session);
    assert.ok(entry);
    assert.equal(entry.workspaceRoot?.toLowerCase(), second.fsPath.toLowerCase());
    assert.equal(entry.files[0].workspaceRoot?.toLowerCase(), second.fsPath.toLowerCase());
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  });

  test('Hook 配置幂等、保留其他事件并可移除', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-config-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = temporary;
    try {
      const file = path.join(temporary, 'hooks.json');
      await fs.writeFile(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } }), 'utf8');
      await vscode.commands.executeCommand('editTimelineForCodex.installHooks');
      const first = await fs.readFile(file, 'utf8');
      await vscode.commands.executeCommand('editTimelineForCodex.installHooks');
      assert.equal(await fs.readFile(file, 'utf8'), first);
      const installed = JSON.parse(first);
      assert.deepEqual(Object.keys(installed.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit'].sort());
      await vscode.commands.executeCommand('editTimelineForCodex.removeHooks');
      assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).hooks), ['SessionStart']);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  test('损坏的 Hook 配置保持原样', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-timeline-corrupt-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = temporary;
    try {
      const file = path.join(temporary, 'hooks.json');
      const broken = '{"hooks":';
      await fs.writeFile(file, broken, 'utf8');
      await vscode.commands.executeCommand('editTimelineForCodex.installHooks');
      assert.equal(await fs.readFile(file, 'utf8'), broken);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  if (process.env.EDIT_TIMELINE_PERF === '1') {
    test('一万文件工作区的扩展宿主事件循环延迟', async function () {
      this.timeout(180_000);
      const folders = vscode.workspace.workspaceFolders || [];
      assert.equal(folders.length, 2);
      const root = path.join(folders[1].uri.fsPath, 'performance-workspace');
      await fs.mkdir(root, { recursive: true });
      try {
        const body = 'a'.repeat(10240);
        for (let dir = 0; dir < 100; dir++) {
          const folder = path.join(root, `group-${dir}`);
          await fs.mkdir(folder);
          await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(path.join(folder, `file-${index}.txt`), `${dir}:${index}\n${body}`, 'utf8')));
        }
        let maxDelay = 0;
        let last = Date.now();
        const timer = setInterval(() => {
          const now = Date.now();
          maxDelay = Math.max(maxDelay, now - last - 50);
          last = now;
        }, 50);
        const session = randomUUID();
        const turn = randomUUID();
        let timing: { bridgeMs: number; settledMs: number };
        try { timing = await sendHook(event('PreToolUse', session, turn)); }
        finally { clearInterval(timer); }
        console.log(`PERF_EXTENSION_HOST={"files":10000,"textBytes":102400000,"preHookMs":${timing.bridgeMs},"settledMs":${timing.settledMs},"maxEventLoopDelayMs":${maxDelay}}`);
        await sendHook(event('PostToolUse', session, turn));
      } finally {
        const workspaceRoot = path.resolve(folders[1].uri.fsPath);
        const target = path.resolve(root);
        assert.ok(target.startsWith(`${workspaceRoot}${path.sep}`));
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
