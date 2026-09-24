import * as vscode from 'vscode';
import {
  filterSessions,
  groupByDate,
  type SessionFilter,
  type TimeRange,
} from '../core/query';
import type { AISession, AssistantId, FileChange } from '../core/types';
import type { SessionHistoryStore } from '../core/historyStore';
import { sourceLabel } from '../core/exporters';

export type TimelineNode =
  | { kind: 'group'; label: string; sessionIds: string[] }
  | { kind: 'session'; session: AISession; active: boolean }
  | { kind: 'file'; sessionId: string; file: FileChange };

const KIND_BADGES: Record<FileChange['kind'], string> = {
  create: 'A',
  change: 'M',
  delete: 'D',
};

export class TimelineView implements vscode.TreeDataProvider<TimelineNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TimelineNode | undefined>();
  private readonly visibleSessionNodes = new Map<string, TimelineNode & { kind: 'session' }>();
  private filter: SessionFilter = { query: '', range: 'all', assistants: [] };
  private sessions: AISession[] = [];

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly root: vscode.Uri,
    private readonly history: SessionHistoryStore,
  ) {}

  get activeFilter(): SessionFilter {
    return { ...this.filter };
  }

  get isFiltered(): boolean {
    return (
      this.filter.query.trim() !== '' ||
      this.filter.range !== 'all' ||
      this.filter.assistants.length > 0
    );
  }

  setQuery(query: string): void {
    this.filter = { ...this.filter, query };
    this.refresh();
  }

  setRange(range: TimeRange): void {
    this.filter = { ...this.filter, range };
    this.refresh();
  }

  setAssistants(assistants: AssistantId[]): void {
    this.filter = { ...this.filter, assistants };
    this.refresh();
  }

  clearFilter(): void {
    this.filter = { query: '', range: 'all', assistants: [] };
    this.refresh();
  }

  refresh(sessionId?: string): void {
    if (!sessionId) {
      this.visibleSessionNodes.clear();
      this.changeEmitter.fire(undefined);
      return;
    }
    const node = this.visibleSessionNodes.get(sessionId);
    if (!node) {
      this.changeEmitter.fire(undefined);
      return;
    }
    void this.history.find(sessionId).then((session) => {
      if (!session) return this.changeEmitter.fire(undefined);
      node.session = session;
      this.changeEmitter.fire(node);
    });
  }

  async sessionCount(): Promise<number> {
    return (await this.history.all()).length;
  }

  getTreeItem(node: TimelineNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group':
        return groupItem(node.label, node.sessionIds.length);
      case 'session':
        return sessionItem(node.session, node.active);
      case 'file':
        return fileItem(this.root, node.sessionId, node.file);
    }
  }

  async getChildren(node?: TimelineNode): Promise<TimelineNode[]> {
    if (!node) {
      return this.rootNodes();
    }

    if (node.kind === 'group') {
      const byId = new Map(this.sessions.map((s) => [s.id, s]));
      const nodes = node.sessionIds
        .map((id) => byId.get(id))
        .filter((session): session is AISession => session !== undefined)
        .map((session) => ({
          kind: 'session' as const,
          session,
          active: false,
        }));
      for (const item of nodes) this.visibleSessionNodes.set(item.session.id, item);
      return nodes;
    }

    if (node.kind === 'session') {
      return node.session.files.map((file) => ({
        kind: 'file' as const,
        sessionId: node.session.id,
        file,
      }));
    }

    return [];
  }

  private async rootNodes(): Promise<TimelineNode[]> {
    const stored = await this.history.all();
    this.sessions = stored;

    const now = Date.now();
    const visible = filterSessions(this.sessions, this.filter, now);

    if (visible.length === 0) {
      return this.isFiltered
        ? [{ kind: 'group', label: '没有符合筛选条件的记录', sessionIds: [] }]
        : [];
    }

    return groupByDate(visible, now).map((group) => ({
      kind: 'group' as const,
      label: group.label,
      sessionIds: group.sessions.map((s) => s.id),
    }));
  }
}

function groupItem(label: string, count: number): vscode.TreeItem {
  const item = new vscode.TreeItem(
    label,
    count > 0
      ? label === '今天'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.description = count > 0 ? `${count} 条记录` : undefined;
  item.contextValue = 'codexGroup';
  return item;
}

function sessionItem(session: AISession, active: boolean): vscode.TreeItem {
  const time = new Date(session.startedAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const prompt = session.prompt?.trim() || '未捕获提示词';
  const label = `${prompt} — ${time}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);

  const lines = session.stats.added || session.stats.deleted
    ? ` · +${session.stats.added} −${session.stats.deleted}`
    : '';
  item.description = `${sourceLabel(session.ai)} · ${fileSummary(session.files)}${lines}`;
  item.tooltip = sessionTooltip(session);
  item.contextValue = session.pinned ? 'codexSession.pinned' : 'codexSession';
  item.iconPath = new vscode.ThemeIcon(
    active ? 'sync~spin' : session.pinned ? 'pinned' : 'sparkle',
  );
  item.id = `session:${session.id}`;
  return item;
}

function sessionTooltip(session: AISession): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${session.prompt?.trim() || '_未捕获提示词_'}**\n\n`);
  md.appendMarkdown(`- 来源：${sourceLabel(session.ai)}\n`);
  md.appendMarkdown(`- 记录起点：${new Date(session.startedAt).toLocaleString()}\n`);
  md.appendMarkdown(`- 最后更新时间：${new Date(session.lastUpdatedAt || session.endedAt || session.startedAt).toLocaleString()}\n`);
  if (session.ai !== 'manual') {
    md.appendMarkdown(`- 采集跨度：${session.duration > 0 ? formatDuration(session.duration) : '未记录（旧记录或缺少工具前回调）'}\n`);
  }
  md.appendMarkdown(`- 文件：${fileSummary(session.files, true)}\n`);
  md.appendMarkdown(`- 行数：+${session.stats.added} −${session.stats.deleted}\n`);
  if (session.incomplete) md.appendMarkdown('- 采集：不完整\n');
  if (session.attributionUncertain) md.appendMarkdown('- 归属：并发修改，归属不确定\n');
  if (session.notes) {
    md.appendMarkdown(`\n${session.notes}\n`);
  }
  return md;
}

function fileItem(root: vscode.Uri, sessionId: string, file: FileChange): vscode.TreeItem {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(file.workspaceRoot || root.fsPath), file.path);
  const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
  item.label = basename(file.path);

  const directory = dirname(file.path);
  const lines = file.added || file.deleted ? ` +${file.added} −${file.deleted}` : '';
  item.description = `${directory ? `${directory} ` : ''}${KIND_BADGES[file.kind]}${lines}`;
  item.resourceUri = uri;

  const restorable = file.snapshot === 'captured';
  item.contextValue = restorable ? 'codexFile.restorable' : 'codexFile.readonly';
  item.tooltip = restorable
    ? `${file.path}\n\n点击比较本回合修改前后的版本。`
    : `${file.path}\n\n无法比较或恢复：${file.reason || describeSnapshot(file.snapshot)}。`;

  item.command = restorable
    ? {
        command: 'editTimelineForCodex.compare',
        title: '比较',
        arguments: [{ kind: 'file', sessionId, file }],
      }
    : {
        command: 'vscode.open',
        title: '打开',
        arguments: [uri],
      };
  return item;
}

function fileSummary(files: FileChange[], words = false): string {
  const counts = { change: 0, create: 0, delete: 0 };
  for (const file of files) {
    counts[file.kind]++;
  }
  const parts = words
    ? [
        counts.change ? `修改 ${counts.change}` : '',
        counts.create ? `新增 ${counts.create}` : '',
        counts.delete ? `删除 ${counts.delete}` : '',
      ]
    : [
        counts.change ? `${counts.change}M` : '',
        counts.create ? `${counts.create}A` : '',
        counts.delete ? `${counts.delete}D` : '',
      ];
  return parts.filter(Boolean).join(words ? '，' : ' ') || `${files.length} 个文件`;
}

function describeSnapshot(state: FileChange['snapshot']): string {
  switch (state) {
    case 'too-large':
      return '文件超过快照大小上限';
    case 'binary':
      return '二进制文件';
    case 'disabled':
      return '快照已关闭';
    default:
      return '缺少修改前快照';
  }
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} 毫秒`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
