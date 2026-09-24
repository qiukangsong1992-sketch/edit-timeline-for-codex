import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionHistoryStore } from './core/historyStore';
import { RestoreService, type RestoreReport } from './core/restore';
import type { AISession } from './core/types';
import { MementoStore, VsCodeWorkspaceWriter } from './vscode/adapters';
import { registerCommands } from './vscode/commands';
import { readSettings } from './vscode/config';
import { SNAPSHOT_SCHEME, SnapshotContentProvider } from './vscode/diffProvider';
import { checkRuntime, hookStatus, installHooks, removeHooks, TRUST_INSTRUCTIONS } from './vscode/hookConfiguration';
import { HookReceiver } from './vscode/hookReceiver';
import { HookRecorder, type ActiveTurn } from './vscode/hookRecorder';
import { SessionStatusBar } from './vscode/statusBar';
import { TimelineView, type TimelineNode } from './vscode/timelineView';
import { ScanWorker } from './vscode/workerClient';
import { WorkerSnapshots } from './vscode/workerSnapshots';

export interface EditTimelineForCodexApi {
  readonly version: 1;
  getSessions(): Promise<AISession[]>;
  getActiveTurns(): ActiveTurn[];
  settled(): Promise<void>;
  getSnapshot(ref: string): Promise<string | undefined>;
  restoreFile(sessionId: string, filePath: string): Promise<RestoreReport>;
  restoreSession(sessionId: string): Promise<RestoreReport>;
}

export async function activate(context: vscode.ExtensionContext): Promise<EditTimelineForCodexApi | undefined> {
  const output = vscode.window.createOutputChannel('Edit Timeline For Codex', { log: true });
  context.subscriptions.push(output);
  const log = (message: string) => output.appendLine(message);

  context.subscriptions.push(
    vscode.commands.registerCommand('editTimelineForCodex.installHooks', async () => {
      try {
        const changed = await installHooks(context);
        void vscode.window.showInformationMessage(changed ? `三个 Hook 已配置。${TRUST_INSTRUCTIONS}` : `三个 Hook 已配置，无需重复写入。${TRUST_INSTRUCTIONS}`);
      } catch (error) { void vscode.window.showErrorMessage(`Hook 配置失败：${describe(error)}`); }
    }),
    vscode.commands.registerCommand('editTimelineForCodex.checkHooks', async () => {
      try {
        await checkRuntime(context);
        const status = await hookStatus();
        void vscode.window.showInformationMessage(Object.entries(status).map(([name, installed]) => `${name}：${installed ? '已配置' : '未配置'}`).join('；'));
      } catch (error) { void vscode.window.showErrorMessage(`Hook 检查失败：${describe(error)}`); }
    }),
    vscode.commands.registerCommand('editTimelineForCodex.trustHelp', () => {
      void vscode.window.showInformationMessage(TRUST_INSTRUCTIONS, '查看官方说明').then((choice) => {
        if (choice === '查看官方说明') void vscode.env.openExternal(vscode.Uri.parse('https://learn.chatgpt.com/docs/hooks'));
      });
    }),
    vscode.commands.registerCommand('editTimelineForCodex.removeHooks', async () => {
      try {
        const changed = await removeHooks();
        void vscode.window.showInformationMessage(changed ? '已移除本插件的三个 Hook，其余配置已保留。' : '未找到本插件 Hook。');
      } catch (error) { void vscode.window.showErrorMessage(`移除 Hook 失败：${describe(error)}`); }
    }),
  );

  const roots = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath) || [];
  void vscode.commands.executeCommand('setContext', 'editTimelineForCodex.hasNoWorkspace', roots.length === 0);
  if (!roots.length || process.platform !== 'win32') {
    log(roots.length ? '首版只支持 Windows 本机工作区' : '未打开本机工作区');
    return undefined;
  }

  const root = vscode.Uri.file(roots[0]);
  const workspaceKey = createHash('sha256').update(roots.map((value) => path.resolve(value).toLowerCase()).sort().join('|')).digest('hex').slice(0, 24);
  const worker = new ScanWorker(context, path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'edit-timeline-for-codex', workspaceKey, 'snapshots'));
  context.subscriptions.push(worker);
  const snapshots = new WorkerSnapshots(worker, () => readSettings().maxSnapshotBytes, () => readSettings().maxStorageBytes);
  const history = new SessionHistoryStore({
    memento: new MementoStore(context.workspaceState),
    now: () => Date.now(),
    settings: readSettings,
    releaseRefs: (refs) => snapshots.release(refs),
    log,
  });
  const recorder = new HookRecorder(roots, worker, history, readSettings, (refs) => snapshots.reconcile(refs), log);
  const receiver = new HookReceiver(roots, (event) => recorder.handle(event), log);
  context.subscriptions.push(receiver);
  try { await receiver.start(); } catch (error) { log(`命名管道启动失败：${describe(error)}`); }

  const restore = new RestoreService({
    history,
    snapshots,
    writer: new VsCodeWorkspaceWriter(roots),
    recordRestore: async (entries, label) => {
      const at = Date.now();
      await history.append({
        id: `restore-${at}-${Math.random().toString(36).slice(2)}`,
        startedAt: at,
        endedAt: at,
        lastUpdatedAt: at,
        ai: 'manual',
        detection: 'manual',
        prompt: label,
        duration: 0,
        files: entries.map((entry) => ({
          path: entry.path,
          workspaceRoot: entry.workspaceRoot,
          kind: entry.kind,
          beforeRef: entry.beforeRef,
          snapshot: entry.beforeRef ? 'captured' : 'unavailable',
          added: 0,
          deleted: 0,
        })),
        stats: { added: 0, deleted: 0 },
      });
    },
    log,
  });

  const view = new TimelineView(root, history);
  const treeView = vscode.window.createTreeView<TimelineNode>('editTimelineForCodex.timeline', { treeDataProvider: view, showCollapseAll: true });
  const statusBar = new SessionStatusBar(() => readSettings().showStatusBar);
  context.subscriptions.push(treeView, statusBar, vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotContentProvider(snapshots)));

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let fullRefresh = false;
  const affected = new Set<string>();
  const refresh = (sessionId?: string) => {
    if (sessionId) affected.add(sessionId);
    else fullRefresh = true;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (fullRefresh) view.refresh();
      else for (const id of affected) view.refresh(id);
      fullRefresh = false;
      affected.clear();
      void history.all().then((sessions) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const count = sessions.filter((session) => session.startedAt >= today.getTime()).length;
        treeView.badge = count ? { value: count, tooltip: `今天 ${count} 条编辑记录` } : undefined;
        statusBar.update(sessions[0]);
      }).catch((error: unknown) => log(`视图刷新失败：${describe(error)}`));
    }, 200);
  };
  const cleanup = () => {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      cleanupTimer = undefined;
      void recorder.maintenance(async () => {
        await history.prune();
        const sessions = await history.all();
        await snapshots.reconcile(sessions.flatMap((session) => session.files.flatMap((file) => [file.beforeRef, file.afterRef].filter((ref): ref is string => Boolean(ref)))));
      }).catch((error: unknown) => log(`快照清理失败：${describe(error)}`));
    }, 1000);
  };
  context.subscriptions.push(
    history.onDidChangeHistory((id) => { refresh(id); cleanup(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editTimelineForCodex')) { refresh(); cleanup(); }
    }),
    { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); if (cleanupTimer) clearTimeout(cleanupTimer); } },
    ...registerCommands({ root, history, restore, view, treeView, refresh, log }),
  );
  refresh();
  cleanup();
  log('Edit Timeline For Codex 已启动');
  return {
    version: 1,
    getSessions: () => history.all(),
    getActiveTurns: () => recorder.activeTurns(),
    settled: () => recorder.settled(),
    getSnapshot: (ref) => snapshots.get(ref),
    restoreFile: (sessionId, filePath) => restore.restoreFile(sessionId, filePath),
    restoreSession: (sessionId) => restore.restoreSession(sessionId),
  };
}

export function deactivate(): void {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
