import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
const LAUNCHER_NAME = 'EditTimelineForCodex-hook.ps1';

interface HookHandler { type?: string; command?: string; timeout?: number }
interface HookGroup { hooks?: HookHandler[]; [key: string]: unknown }
interface HookFile { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

function home(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function hookPath(): string {
  return path.join(home(), 'hooks.json');
}

function commandFor(launcher: string): string {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcher}"`;
}

function owned(handler: HookHandler): boolean {
  return handler.type === 'command'
    && typeof handler.command === 'string'
    && handler.command.toLowerCase().includes(LAUNCHER_NAME.toLowerCase());
}

function configured(handler: HookHandler, launcher: string): boolean {
  return handler.type === 'command'
    && handler.timeout === 15
    && typeof handler.command === 'string'
    && handler.command.trim().toLowerCase() === commandFor(launcher).toLowerCase();
}

async function readConfig(): Promise<HookFile> {
  let raw: string;
  try { raw = await fs.readFile(hookPath(), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hooks: {} };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Codex hooks.json 已损坏，原文件未修改'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex hooks.json 格式无效，原文件未修改');
  const config = parsed as HookFile;
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) {
    throw new Error('Codex hooks.json 中 hooks 格式无效，原文件未修改');
  }
  return config;
}

async function writeConfig(config: HookFile): Promise<void> {
  const file = hookPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const current = await fs.readFile(file);
    await fs.writeFile(`${file}.bak-${Date.now()}`, current, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

function launcherText(runtime: string, bridge: string): string {
  const quote = (value: string) => value.replace(/'/g, "''");
  return `$env:ELECTRON_RUN_AS_NODE = '1'\n& '${quote(runtime)}' '${quote(bridge)}' @args\nexit $LASTEXITCODE\n`;
}

export async function checkRuntime(context: vscode.ExtensionContext): Promise<void> {
  const bridge = context.asAbsolutePath(path.join('hook', 'bridge.cjs'));
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, '--self-test'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Node 运行模式退出码：${code}`)));
  });
  if (output.trim() !== 'ok') throw new Error('VS Code Node 运行模式自检失败');
}

export async function installHooks(context: vscode.ExtensionContext): Promise<boolean> {
  await checkRuntime(context);
  const root = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri.fsPath;
  if (!root) throw new Error('请先在 VS Code 中打开本机项目文件夹');
  const config = await readConfig();
  const launcher = path.join(context.globalStorageUri.fsPath, LAUNCHER_NAME);
  const expectedLauncher = `\uFEFF${launcherText(process.execPath, context.asAbsolutePath(path.join('hook', 'bridge.cjs')))}`;
  const currentLauncher = await fs.readFile(launcher, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const launcherChanged = currentLauncher !== expectedLauncher;
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  if (launcherChanged) await fs.writeFile(launcher, expectedLauncher, 'utf8');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '--pipe-self-test'], {
      cwd: root,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 && stdout.trim() === 'ok' ? resolve() : reject(new Error(`启动器或命名管道自检失败：${code} ${stderr.trim()}`)));
  });
  config.hooks ??= {};
  let changed = launcherChanged;
  for (const event of EVENTS) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`${event} 配置格式无效，原文件未修改`);
    let foundCurrent = false;
    const updated = groups.map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      const hooks = group.hooks.filter((handler) => {
        if (configured(handler, launcher) && !foundCurrent) {
          foundCurrent = true;
          return true;
        }
        if (owned(handler)) {
          changed = true;
          return false;
        }
        return true;
      });
      return hooks.length === group.hooks.length ? group : { ...group, hooks };
    }).filter((group) => group.hooks === undefined || group.hooks.length > 0);
    if (!foundCurrent) {
      updated.push({ hooks: [{ type: 'command', command: commandFor(launcher), timeout: 15 }] });
      changed = true;
    }
    config.hooks[event] = updated;
  }
  if (changed && config.hooks) await writeConfig(config);
  return changed;
}

export async function hookStatus(context: vscode.ExtensionContext): Promise<Record<string, boolean>> {
  const config = await readConfig();
  const launcher = path.join(context.globalStorageUri.fsPath, LAUNCHER_NAME);
  const expectedLauncher = `\uFEFF${launcherText(process.execPath, context.asAbsolutePath(path.join('hook', 'bridge.cjs')))}`;
  const launcherReady = await fs.readFile(launcher, 'utf8').then(
    (text) => text === expectedLauncher,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  return Object.fromEntries(EVENTS.map((event) => [
    event,
    launcherReady && Boolean(config.hooks?.[event]?.some((group) => group.hooks?.some((handler) => configured(handler, launcher)))),
  ]));
}

export async function removeHooks(): Promise<boolean> {
  const config = await readConfig();
  if (!config.hooks) return false;
  let changed = false;
  for (const event of EVENTS) {
    const original = config.hooks[event];
    if (!Array.isArray(original)) continue;
    const groups = original.map((group) => ({ ...group, hooks: group.hooks?.filter((handler) => !owned(handler)) }))
      .filter((group) => group.hooks === undefined || group.hooks.length > 0);
    if (groups.length !== original.length || groups.some((group, index) => group.hooks?.length !== original[index]?.hooks?.length)) changed = true;
    if (groups.length) config.hooks[event] = groups;
    else delete config.hooks[event];
  }
  if (changed) await writeConfig(config);
  return changed;
}

export const TRUST_INSTRUCTIONS = '请重新启动 Codex，输入 /hooks，检查并信任本插件的 UserPromptSubmit、PreToolUse、PostToolUse 三个 Hook，然后发起一次编辑验证。插件不会修改信任状态。';
