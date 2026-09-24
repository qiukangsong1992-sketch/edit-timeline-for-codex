import * as vscode from 'vscode';
import { sourceLabel, toCsv, toJson, toMarkdown } from '../core/exporters';
import { mergeSessions } from '../core/merge';
import { computeStatistics, type TimeRange } from '../core/query';
import type { SessionHistoryStore } from '../core/historyStore';
import type { RestoreService, RestoreReport } from '../core/restore';
import type { AISession, AssistantId, FileChange } from '../core/types';
import { snapshotUri } from './diffProvider';
import type { TimelineNode, TimelineView } from './timelineView';

export interface CommandDeps {
  root: vscode.Uri;
  history: SessionHistoryStore;
  restore: RestoreService;
  view: TimelineView;
  treeView: vscode.TreeView<TimelineNode>;
  refresh: () => void;
  log: (message: string) => void;
}

const RANGE_CHOICES: { label: string; value: TimeRange }[] = [
  { label: '全部时间', value: 'all' },
  { label: '今天', value: 'today' },
  { label: '昨天', value: 'yesterday' },
  { label: '最近 7 天', value: 'week' },
];

const ASSISTANT_CHOICES: { label: string; value: AssistantId }[] = [
  { label: 'Codex', value: 'codex' },
  { label: '恢复操作', value: 'manual' },
];

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        await handler(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`${id} failed: ${message}`);
        void vscode.window.showErrorMessage(`Edit Timeline For Codex：${message}`);
      }
    });

  return [
    register('editTimelineForCodex.openTimeline', () =>
      vscode.commands.executeCommand('editTimelineForCodex.timeline.focus'),
    ),

    register('editTimelineForCodex.refresh', () => deps.refresh()),

    register('editTimelineForCodex.compare', (node: TimelineNode) => compare(deps, node)),

    register('editTimelineForCodex.restoreFile', (node: TimelineNode) => restoreFile(deps, node)),

    register('editTimelineForCodex.restoreSession', (node: TimelineNode) => restoreSession(deps, node)),

    register('editTimelineForCodex.revealInExplorer', (node: TimelineNode) => {
      const file = fileOf(node);
      if (file) {
        void vscode.commands.executeCommand(
          'revealInExplorer',
          vscode.Uri.joinPath(vscode.Uri.file(file.workspaceRoot || deps.root.fsPath), file.path),
        );
      }
    }),

    register('editTimelineForCodex.copyPath', async (node: TimelineNode) => {
      const file = fileOf(node);
      if (file) {
        await vscode.env.clipboard.writeText(file.path);
        void vscode.window.setStatusBarMessage(`已复制 ${file.path}`, 2000);
      }
    }),

    register('editTimelineForCodex.search', async () => {
      const query = await vscode.window.showInputBox({
        title: '搜索编辑记录',
        prompt: '搜索提示词、文件路径和备注；空格分隔的词需全部匹配。',
        value: deps.view.activeFilter.query,
        placeHolder: '例如：登录验证',
      });
      if (query !== undefined) {
        deps.view.setQuery(query);
        await syncFilterContext(deps.view);
      }
    }),

    register('editTimelineForCodex.clearSearch', async () => {
      deps.view.clearFilter();
      await syncFilterContext(deps.view);
    }),

    register('editTimelineForCodex.filter', async () => {
      const range = await vscode.window.showQuickPick(
        RANGE_CHOICES.map((choice) => ({
          label: choice.label,
          picked: deps.view.activeFilter.range === choice.value,
          value: choice.value,
        })),
        { title: '按时间筛选' },
      );
      if (!range) {
        return;
      }
      deps.view.setRange(range.value);

      const assistants = await vscode.window.showQuickPick(
        ASSISTANT_CHOICES.map((choice) => ({
          label: choice.label,
          picked: deps.view.activeFilter.assistants.includes(choice.value),
          value: choice.value,
        })),
        { title: '按来源筛选；不选择表示全部', canPickMany: true },
      );
      deps.view.setAssistants((assistants ?? []).map((choice) => choice.value));
      await syncFilterContext(deps.view);
    }),

    register('editTimelineForCodex.setPrompt', async (node: TimelineNode) => {
      const session = sessionOf(node);
      if (!session) {
        return;
      }
      const prompt = await vscode.window.showInputBox({
        title: '编辑提示词或标签',
        value: session.prompt ?? '',
        prompt: '输入这条记录的说明，仅保存在本机。',
      });
      if (prompt === undefined) {
        return;
      }
      await deps.history.update(session.id, { prompt: prompt.trim() || undefined });
      deps.refresh();
    }),

    register('editTimelineForCodex.togglePin', async (node: TimelineNode) => {
      const session = sessionOf(node);
      if (!session) {
        return;
      }
      await deps.history.update(session.id, { pinned: !session.pinned });
      deps.refresh();
    }),

    register('editTimelineForCodex.mergeWithPrevious', (node: TimelineNode) => mergeWithPrevious(deps, node)),

    register('editTimelineForCodex.deleteSession', async (node: TimelineNode) => {
      const session = sessionOf(node);
      if (!session) {
        return;
      }
      const confirmed = await confirm(
        '删除这条编辑记录？',
        '工作区文件不受影响；这条记录的快照会被清理。',
        '删除记录',
      );
      if (confirmed) {
        await deps.history.remove([session.id]);
        deps.refresh();
      }
    }),

    register('editTimelineForCodex.showStatistics', () => showStatistics(deps)),

    register('editTimelineForCodex.exportHistory', () => exportHistory(deps)),

    register('editTimelineForCodex.deleteHistory', async () => {
      const count = (await deps.history.all()).length;
      if (count === 0) {
        void vscode.window.showInformationMessage('没有可清空的历史记录。');
        return;
      }
      const confirmed = await confirm(
        `清空全部 ${count} 条编辑记录？`,
        '工作区文件不受影响；快照将被清理，无法再查看差异或恢复。',
        '清空历史',
      );
      if (confirmed) {
        await deps.history.clear();
        deps.refresh();
        void vscode.window.showInformationMessage('历史记录已清空。');
      }
    }),
  ];
}

// -------------------------------------------------------------------- handlers

async function compare(deps: CommandDeps, node: TimelineNode): Promise<void> {
  const file = fileOf(node);
  const sessionId = sessionIdOf(node);
  if (!file || !sessionId) {
    return;
  }

  if (file.snapshot !== 'captured' || !file.beforeRef) {
    void vscode.window.showWarningMessage(
      `文件 ${file.path} 没有修改前快照，无法比较。`,
    );
    return;
  }

  const session = (await deps.history.all()).find((s) => s.id === sessionId);
  const when = session
    ? new Date(session.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '回合';

  const left = snapshotUri(file.path, file.beforeRef, `修改前-${when}`);
  const right =
    file.kind === 'delete'
      // A deleted file has no afterRef; an empty ref resolves to empty content,
      // which is what "after" a deletion actually looks like.
      ? snapshotUri(file.path, '', '已删除')
      : file.afterRef
        ? snapshotUri(file.path, file.afterRef, `修改后-${when}`)
        : vscode.Uri.joinPath(vscode.Uri.file(file.workspaceRoot || deps.root.fsPath), file.path);

  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${basename(file.path)} — 修改前 ↔ ${file.afterRef ? '修改后' : '当前内容'}`,
    { preview: true },
  );
}

async function restoreFile(deps: CommandDeps, node: TimelineNode): Promise<void> {
  const file = fileOf(node);
  const sessionId = sessionIdOf(node);
  if (!file || !sessionId) {
    return;
  }

  const confirmed = await confirm(
    `将 ${basename(file.path)} 恢复到本回合修改前？`,
    `${file.path} 将被修改前快照覆盖。`,
    '恢复',
  );
  if (!confirmed) {
    return;
  }

  reportRestore(await deps.restore.restoreFile(sessionId, file.path));
  deps.refresh();
}

async function restoreSession(deps: CommandDeps, node: TimelineNode): Promise<void> {
  const session = sessionOf(node);
  if (!session) {
    return;
  }

  const paths = await deps.restore.restorablePaths(session.id);
  if (paths.length === 0) {
    void vscode.window.showWarningMessage(
      '本回合没有可恢复的文件快照。',
    );
    return;
  }

  const preview = paths.slice(0, 10).join('\n');
  const more = paths.length > 10 ? `\n……另有 ${paths.length - 10} 个文件` : '';
  const confirmed = await confirm(
    `将 ${paths.length} 个文件恢复到本回合修改前？`,
    `以下文件将被覆盖：\n\n${preview}${more}`,
    '全部恢复',
  );
  if (!confirmed) {
    return;
  }

  reportRestore(await deps.restore.restoreSession(session.id));
  deps.refresh();
}

async function mergeWithPrevious(deps: CommandDeps, node: TimelineNode): Promise<void> {
  const session = sessionOf(node);
  if (!session) {
    return;
  }

  const all = await deps.history.all();
  const index = all.findIndex((s) => s.id === session.id);
  // `all` is newest first, so the chronologically previous session is the next one.
  const previous = all.slice(index + 1).find((entry) => entry.workspaceRoot === session.workspaceRoot);
  if (!previous) {
    void vscode.window.showInformationMessage(
      '没有可合并的更早记录。',
    );
    return;
  }

  const merged = mergeSessions(previous, session);
  await deps.history.update(previous.id, merged);
  await deps.history.remove([session.id]);
  deps.refresh();
  void vscode.window.showInformationMessage(
    `已合并到 ${new Date(previous.startedAt).toLocaleTimeString()} 的记录。`,
  );
}

async function showStatistics(deps: CommandDeps): Promise<void> {
  const sessions = await deps.history.all();
  const stats = computeStatistics(sessions, Date.now());

  const lines = [
    '# Edit Timeline For Codex — 统计',
    '',
    '## 今天',
    '',
    `- 记录：**${stats.today.sessions}**`,
    `- 修改文件：**${stats.today.files}**（${stats.today.uniqueFiles} 个不同文件）`,
    `- 行数：**+${stats.today.added}** / **−${stats.today.deleted}**`,
    `- 每条记录平均文件数：**${stats.today.averageFilesPerSession}**`,
    '',
    '## 全部时间',
    '',
    `- 记录：**${stats.allTime.sessions}**`,
    `- 修改文件：**${stats.allTime.files}**（${stats.allTime.uniqueFiles} 个不同文件）`,
    `- 行数：**+${stats.allTime.added}** / **−${stats.allTime.deleted}**`,
    '',
  ];

  if (stats.byAssistant.length > 0) {
    lines.push('## 按来源', '');
    for (const entry of stats.byAssistant) {
      lines.push(`- ${sourceLabel(entry.ai)}：**${entry.sessions}**`);
    }
    lines.push('');
  }

  if (stats.hottestFiles.length > 0) {
    lines.push('## 修改最多的文件', '');
    const max = stats.hottestFiles[0].sessions;
    for (const entry of stats.hottestFiles) {
      const bar = '█'.repeat(Math.max(1, Math.round((entry.sessions / max) * 20)));
      lines.push(`- \`${entry.path}\` ${bar} ${entry.sessions}`);
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function exportHistory(deps: CommandDeps): Promise<void> {
  const sessions = await deps.history.all();
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('没有可导出的历史记录。');
    return;
  }

  const format = await vscode.window.showQuickPick(
    [
      { label: 'Markdown', detail: '每条记录一个章节', value: 'md' },
      { label: 'JSON', detail: '结构化历史，不含快照正文', value: 'json' },
      { label: 'CSV', detail: '每个修改文件一行', value: 'csv' },
    ],
    { title: `导出 ${sessions.length} 条记录` },
  );
  if (!format) {
    return;
  }

  const content =
    format.value === 'md' ? toMarkdown(sessions) : format.value === 'csv' ? toCsv(sessions) : toJson(sessions);

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(deps.root, `edit-timeline-for-codex.${format.value}`),
    filters: { [format.label]: [format.value] },
  });
  if (!target) {
    return;
  }

  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  const open = await vscode.window.showInformationMessage(
    `已导出 ${sessions.length} 条记录。`,
    '打开文件',
  );
  if (open === '打开文件') {
    await vscode.window.showTextDocument(target);
  }
}

// --------------------------------------------------------------------- helpers

function reportRestore(report: RestoreReport): void {
  const parts: string[] = [];
  if (report.restored.length > 0) {
    parts.push(`已恢复 ${report.restored.length}`);
  }
  if (report.skipped.length > 0) {
    parts.push(`已跳过 ${report.skipped.length}`);
  }
  if (report.failed.length > 0) {
    parts.push(`失败 ${report.failed.length}`);
  }

  const summary = `Edit Timeline For Codex：${parts.join('，') || '没有可恢复的文件'}。`;
  const problems = [...report.skipped, ...report.failed];

  if (problems.length === 0) {
    void vscode.window.showInformationMessage(summary);
    return;
  }

  const detail = problems.map((p) => `${p.path} — ${p.reason}`).join('\n');
  void vscode.window.showWarningMessage(summary, { modal: false, detail }, '查看详情').then((choice) => {
    if (choice === '查看详情') {
      void vscode.window.showWarningMessage(detail, { modal: true });
    }
  });
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    action,
  );
  return choice === action;
}

async function syncFilterContext(view: TimelineView): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'editTimelineForCodex.isFiltered', view.isFiltered);
}

function fileOf(node: TimelineNode | undefined): FileChange | undefined {
  return node?.kind === 'file' ? node.file : undefined;
}

function sessionIdOf(node: TimelineNode | undefined): string | undefined {
  if (node?.kind === 'file') {
    return node.sessionId;
  }
  return node?.kind === 'session' ? node.session.id : undefined;
}

function sessionOf(node: TimelineNode | undefined): AISession | undefined {
  return node?.kind === 'session' ? node.session : undefined;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
