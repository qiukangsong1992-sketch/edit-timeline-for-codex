import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { SessionHistoryStore } from '../core/historyStore';
import type { AISession, FileChange } from '../core/types';
import type { Settings } from './config';
import type { CodexHookEvent } from './hookReceiver';
import type { ScanWorker } from './workerClient';

interface ScanResult { files: FileChange[]; complete: boolean; at: number }
export interface ActiveTurn { workspaceRoot: string; sessionId: string; turnId: string; toolUseIds: string[] }

function keyOf(root: string, event: CodexHookEvent): string {
  return `${root}\0${event.session_id || '未知会话'}\0${event.turn_id || '未知回合'}`;
}

function sessionId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function targetsFor(event: CodexHookEvent): string[] | undefined {
  if (event.tool_name !== 'apply_patch') return undefined;
  const command = event.tool_input?.command;
  if (typeof command !== 'string' || !command.includes('*** Begin Patch') || !command.includes('*** End Patch')) return undefined;
  const names: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    if (!line.startsWith('*** ')) continue;
    if (/^\*\*\* (Begin Patch|End Patch)$/.test(line)) continue;
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match || !match[1].trim()) return undefined;
    names.push(match[1].trim());
  }
  return names.length ? [...new Set(names.map((name) => path.resolve(event.cwd || process.cwd(), name)))] : undefined;
}

/** 三个 Hook 的轻量调度；每个工具 Post 成功后立即提交历史。 */
export class HookRecorder {
  private readonly prompts = new Map<string, string>();
  private readonly active = new Map<string, Set<string>>();
  private readonly activeAt = new Map<string, number>();
  private readonly uncertain = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly incomplete = new Set<string>();
  private readonly processed = new Map<string, number>();

  constructor(
    private readonly roots: string[],
    private readonly worker: Pick<ScanWorker, 'request'>,
    private readonly history: SessionHistoryStore,
    private readonly settings: () => Settings,
    private readonly reconcile: (refs: string[]) => Promise<unknown>,
    private readonly log: (message: string) => void,
  ) {}

  async handle(event: CodexHookEvent): Promise<void> {
    await this.maintenance(async () => {
      // 桥接进程启动与 IPC 也计入 10 秒采集窗口，额外留 1 秒给回执。
      const deadline = typeof event.bridge_started_at === 'number'
        ? Math.min(Date.now() + 10000, event.bridge_started_at + 9000)
        : Date.now() + 10000;
      for (const root of this.roots) await this.handleRoot(root, event, deadline);
    });
  }

  async settled(): Promise<void> {
    await this.queue;
  }

  activeTurns(): ActiveTurn[] {
    const turns = new Map<string, ActiveTurn>();
    for (const tools of this.active.values()) {
      for (const key of tools) {
        const [workspaceRoot, sessionId, turnId, toolUseId] = key.split('\0');
        const turnKey = `${workspaceRoot}\0${sessionId}\0${turnId}`;
        const entry = turns.get(turnKey) || { workspaceRoot, sessionId, turnId, toolUseIds: [] };
        entry.toolUseIds.push(toolUseId);
        turns.set(turnKey, entry);
      }
    }
    return [...turns.values()];
  }

  maintenance(action: () => Promise<void>): Promise<void> {
    const task = this.queue.catch(() => {}).then(action);
    this.queue = task;
    return task;
  }

  private async handleRoot(root: string, event: CodexHookEvent, deadline: number): Promise<void> {
    this.expireActive();
    const turn = keyOf(root, event);
    if (event.hook_event_name === 'UserPromptSubmit') {
      if (this.settings().storePrompts && typeof event.prompt === 'string') this.prompts.set(turn, event.prompt);
      return;
    }
    const tool = `${turn}\0${event.tool_use_id || '未知工具'}`;
    const targets = targetsFor(event);
    const options = { root, key: tool, targets, settings: this.settings(), budgetMs: Math.max(0, deadline - Date.now()) };
    if (event.hook_event_name === 'PreToolUse') {
      if (this.processed.has(tool)) return;
      const active = this.active.get(root) || new Set<string>();
      if (active.has(tool)) return;
      if (active.size > 0 && !active.has(tool)) {
        this.uncertain.add(tool);
        for (const other of active) this.uncertain.add(other);
      }
      active.add(tool);
      this.activeAt.set(tool, Date.now());
      this.active.set(root, active);
      if (options.budgetMs === 0) {
        this.incomplete.add(tool);
        return;
      }
      try { await this.worker.request('pre', options, options.budgetMs + 250); } catch (error) {
        this.incomplete.add(tool);
        this.log(`工具前快照不完整：${describe(error)}`);
      }
      return;
    }
    if (event.hook_event_name !== 'PostToolUse') return;
    if (this.processed.has(tool)) return;
    const id = sessionId(turn);
    const prior = await this.history.find(id);
    if (prior?.toolUseIds?.includes(event.tool_use_id || '未知工具')) return;
    await this.prepareCapacity();
    const captureStartedAt = this.activeAt.get(tool);
    this.active.get(root)?.delete(tool);
    this.activeAt.delete(tool);
    let result: ScanResult;
    options.budgetMs = Math.max(0, deadline - Date.now());
    try {
      result = options.budgetMs === 0
        ? { files: [], complete: false, at: Date.now() }
        : await this.worker.request<ScanResult>('post', options, options.budgetMs + 250);
    } catch (error) {
      this.incomplete.add(tool);
      this.log(`工具后快照不完整：${describe(error)}`);
      result = { files: [], complete: false, at: Date.now() };
    }
    const incomplete = !result.complete || this.incomplete.delete(tool);
    if (!result.files.length && !incomplete) {
      this.processed.set(tool, Date.now());
      return;
    }
    const existing = await this.history.find(id);
    if (existing?.toolUseIds?.includes(event.tool_use_id || '未知工具')) return;
    const files = existing?.files.map((file) => ({ ...file })) || [];
    for (const file of result.files) {
      file.workspaceRoot = root;
      const index = files.findIndex((old) => old.path === file.path && old.workspaceRoot === root);
      if (index < 0) files.push(file);
      else {
        const first = files[index];
        files[index] = {
          ...first,
          afterRef: file.afterRef,
          kind: first.kind === 'create' ? 'create' : file.kind === 'delete' ? 'delete' : 'change',
          reason: first.reason || file.reason,
        };
      }
    }
    // 新回合从首次工具前回调计时；缺少 Pre 时保留 Post 时间作为未知起点。
    const startedAt = existing?.startedAt ?? captureStartedAt ?? result.at;
    const session: AISession = {
      id,
      workspaceRoot: root,
      codexSessionId: event.session_id,
      turnId: event.turn_id,
      toolUseIds: [...(existing?.toolUseIds || []), event.tool_use_id || '未知工具'],
      startedAt,
      endedAt: result.at,
      lastUpdatedAt: result.at,
      ai: 'codex',
      detection: 'api',
      prompt: existing?.prompt || this.prompts.get(turn),
      files,
      duration: Math.max(0, result.at - startedAt),
      stats: existing?.stats || { added: 0, deleted: 0 },
      pinned: existing?.pinned,
      notes: existing?.notes,
      incomplete: existing?.incomplete || incomplete,
      attributionUncertain: existing?.attributionUncertain || this.uncertain.delete(tool),
    };
    if (existing) await this.history.update(id, session);
    else await this.history.append(session);
    this.processed.set(tool, Date.now());
    if (this.settings().enableStatistics && result.files.length) {
      setImmediate(() => { void this.maintenance(() => this.updateStats(id)); });
    }
    setImmediate(() => {
      void this.maintenance(() => this.trimCapacity(id)).catch((error: unknown) => this.log(`容量清理失败：${describe(error)}`));
    });
  }

  private async updateStats(id: string): Promise<void> {
    try {
      const session = await this.history.find(id);
      if (!session) return;
      const files = await Promise.all(session.files.map(async (file) => {
        if (!file.beforeRef && !file.afterRef) return file;
        const stats = await this.worker.request<{ added: number; deleted: number }>('stats', {
          beforeRef: file.beforeRef,
          afterRef: file.afterRef,
        });
        return { ...file, added: stats.added, deleted: stats.deleted };
      }));
      await this.history.update(id, {
        files,
        stats: files.reduce((total, file) => ({ added: total.added + file.added, deleted: total.deleted + file.deleted }), { added: 0, deleted: 0 }),
      });
    } catch (error) { this.log(`差异统计失败：${describe(error)}`); }
  }

  private async prepareCapacity(): Promise<void> {
    const limit = this.settings().maxStorageBytes;
    const reserve = Math.min(this.settings().maxSnapshotBytes * 2, Math.floor(limit / 4));
    const used = await this.worker.request<number>('usage', {});
    if (used + reserve <= limit) return;
    await this.worker.request('evictCache', {});
    const retained = await this.history.all();
    await this.reconcile(retained.flatMap((session) => session.files.flatMap((file) => [file.beforeRef, file.afterRef].filter((ref): ref is string => Boolean(ref)))));
  }

  private async trimCapacity(currentId: string): Promise<void> {
    const limit = this.settings().maxStorageBytes;
    const reserve = Math.min(this.settings().maxSnapshotBytes * 2, Math.floor(limit / 4));
    let used = await this.worker.request<number>('usage', {});
    if (used + reserve <= limit) return;
    const candidates = (await this.history.all()).filter((session) => !session.pinned && session.id !== currentId)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const candidate of candidates) {
      await this.history.remove([candidate.id]);
      const remaining = await this.history.all();
      await this.reconcile(remaining.flatMap((session) => session.files.flatMap((file) => [file.beforeRef, file.afterRef].filter((ref): ref is string => Boolean(ref)))));
      used = await this.worker.request<number>('usage', {});
      if (used + reserve <= limit) break;
    }
  }

  private expireActive(): void {
    const cutoff = Date.now() - 86400000;
    for (const [tool, at] of this.processed) if (at < cutoff) this.processed.delete(tool);
    for (const [tool, at] of this.activeAt) {
      if (at >= cutoff) continue;
      this.activeAt.delete(tool);
      for (const active of this.active.values()) active.delete(tool);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
