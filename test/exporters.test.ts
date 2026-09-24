import { describe, expect, test } from 'vitest';
import { toCsv, toJson, toMarkdown } from '../src/core/exporters';
import type { AISession } from '../src/core/types';

const session: AISession = {
  id: 's1',
  startedAt: new Date(2023, 10, 15, 16, 35, 0).getTime(),
  endedAt: new Date(2023, 10, 15, 16, 35, 38).getTime(),
  ai: 'claude',
  detection: 'burst',
  prompt: 'Implement JWT authentication',
  files: [
    { path: 'src/auth.ts', kind: 'change', snapshot: 'captured', added: 120, deleted: 8 },
    { path: 'src/routes.ts', kind: 'create', snapshot: 'captured', added: 22, deleted: 0 },
  ],
  duration: 38_000,
  stats: { added: 142, deleted: 8 },
};

describe('toMarkdown', () => {
  test('includes the prompt, the files and the statistics', () => {
    const output = toMarkdown([session]);

    expect(output).toContain('Implement JWT authentication');
    expect(output).toContain('src/auth.ts');
    expect(output).toContain('src/routes.ts');
    expect(output).toContain('+142');
    expect(output).toContain('-8');
    expect(output).toContain('未知来源');
  });

  test('labels a session with no prompt rather than leaving a gap', () => {
    const output = toMarkdown([{ ...session, prompt: undefined }]);

    expect(output).toContain('未捕获提示词');
  });

  test('produces a header even with no sessions', () => {
    expect(toMarkdown([])).toContain('# Edit Timeline For Codex 编辑记录');
  });
});

describe('toCsv', () => {
  test('writes one row per file with a header', () => {
    const rows = toCsv([session]).trim().split('\n');

    expect(rows[0]).toBe('记录ID,首次修改时间,来源,提示词,文件,变化,新增行,删除行,说明');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('src/auth.ts');
    expect(rows[1]).toContain('未知来源');
  });

  test('将 Codex 和恢复操作显示为中文界面来源', () => {
    expect(toMarkdown([{ ...session, ai: 'codex' }])).toContain('— Codex');
    expect(toCsv([{ ...session, ai: 'manual' }])).toContain(',恢复操作,');
  });

  test('quotes and escapes a prompt containing commas and quotes', () => {
    const output = toCsv([{ ...session, prompt: 'Fix "auth", then tests' }]);

    expect(output).toContain('"Fix ""auth"", then tests"');
  });

  test('collapses newlines in a prompt so rows stay intact', () => {
    const output = toCsv([{ ...session, prompt: 'line one\nline two' }]);

    expect(output.trim().split('\n')).toHaveLength(3);
  });

  test('emits only a header for an empty history', () => {
    expect(toCsv([]).trim().split('\n')).toHaveLength(1);
  });
});

describe('toJson', () => {
  test('round-trips through JSON.parse', () => {
    const parsed = JSON.parse(toJson([session]));

    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].prompt).toBe('Implement JWT authentication');
  });

  test('omits snapshot refs, which mean nothing outside this machine', () => {
    const withRefs: AISession = {
      ...session,
      files: [{ ...session.files[0], beforeRef: 'abc123', afterRef: 'def456' }],
    };

    const output = toJson([withRefs]);

    expect(output).not.toContain('abc123');
    expect(output).not.toContain('def456');
  });
});
