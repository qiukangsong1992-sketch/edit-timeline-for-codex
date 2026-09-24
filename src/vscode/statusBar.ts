import * as vscode from 'vscode';
import type { AISession } from '../core/types';

/** 显示最近一次提交的编辑与最后更新时间，不推断回合已结束。 */
export class SessionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly enabled: () => boolean) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'editTimelineForCodex.openTimeline';
  }

  update(session: AISession | undefined): void {
    if (!session || !this.enabled()) {
      this.item.hide();
      return;
    }

    const count = session.files.length;
    this.item.text = `$(history) Codex 修改 ${count} 个文件`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**${session.prompt?.trim() || '未捕获提示词'}**`,
        `最后更新时间：${new Date(session.lastUpdatedAt || session.startedAt).toLocaleString()}`,
        '',
        ...session.files.map((f) => `- \`${f.path}\``),
        '',
        '_点击打开编辑时间线。_',
      ].join('\n'),
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
