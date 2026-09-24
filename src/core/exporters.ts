import type { AISession, AssistantId } from './types';

const NO_PROMPT = '未捕获提示词';

export function toMarkdown(sessions: AISession[]): string {
  const lines = ['# Edit Timeline For Codex 编辑记录', ''];

  if (sessions.length === 0) {
    lines.push('暂无编辑记录。');
    return `${lines.join('\n')}\n`;
  }

  for (const session of sessions) {
    const when = new Date(session.startedAt).toLocaleString();
    lines.push(`## ${when} — ${sourceLabel(session.ai)}`, '');
    lines.push(`**提示词：** ${session.prompt?.trim() || NO_PROMPT}`, '');
    lines.push(
      `**文件：** ${session.files.length} · ` +
        `**行数：** +${session.stats.added} -${session.stats.deleted} · ` +
        `**最后更新时间：** ${new Date(session.lastUpdatedAt || session.endedAt || session.startedAt).toLocaleString()}`,
      '',
    );
    lines.push('| 文件 | 变化 | 新增行 | 删除行 | 说明 |', '| --- | --- | --: | --: | --- |');
    for (const file of session.files) {
      lines.push(`| \`${file.path}\` | ${kindLabel(file.kind)} | +${file.added} | -${file.deleted} | ${file.reason || ''} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function toCsv(sessions: AISession[]): string {
  const rows = ['记录ID,首次修改时间,来源,提示词,文件,变化,新增行,删除行,说明'];

  for (const session of sessions) {
    const shared = [
      session.id,
      new Date(session.startedAt).toISOString(),
      sourceLabel(session.ai),
      session.prompt ?? '',
    ];
    for (const file of session.files) {
      rows.push(
        [...shared, file.path, kindLabel(file.kind), String(file.added), String(file.deleted), file.reason || '']
          .map(csvCell)
          .join(','),
      );
    }
  }

  return `${rows.join('\n')}\n`;
}

export function toJson(sessions: AISession[]): string {
  return `${JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      // Snapshot refs are local storage addresses; they are meaningless elsewhere.
      sessions: sessions.map(({ files, ...session }) => ({
        ...session,
        files: files.map(({ beforeRef: _b, afterRef: _a, ...file }) => file),
      })),
    },
    null,
    2,
  )}\n`;
}

function csvCell(value: string): string {
  // Newlines would split one record across rows, so they collapse to spaces.
  const flattened = value.replace(/\r?\n/g, ' ');
  return /[",]/.test(flattened) ? `"${flattened.replace(/"/g, '""')}"` : flattened;
}

function kindLabel(kind: 'create' | 'change' | 'delete'): string {
  return kind === 'create' ? '新增' : kind === 'delete' ? '删除' : '修改';
}

export function sourceLabel(source: AssistantId): string {
  return source === 'codex' ? 'Codex' : source === 'manual' ? '恢复操作' : '未知来源';
}
