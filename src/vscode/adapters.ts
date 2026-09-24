import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { KeyValueStore } from '../core/historyStore';
import type { WorkspaceWriter } from '../core/restore';

export class MementoStore implements KeyValueStore {
  constructor(private readonly memento: vscode.Memento) {}

  get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
  }
}

/** 恢复只写入已打开的工作区根目录，并让打开的编辑器保留撤销栈。 */
export class VsCodeWorkspaceWriter implements WorkspaceWriter {
  constructor(private readonly roots: string[]) {}

  async read(relative: string, workspaceRoot?: string): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(await this.uri(relative, workspaceRoot)));
    } catch (error) {
      if ((error as vscode.FileSystemError).code === 'FileNotFound') return undefined;
      throw error;
    }
  }

  async write(relative: string, content: string, workspaceRoot?: string): Promise<void> {
    const uri = await this.uri(relative, workspaceRoot);
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString() && !doc.isClosed);
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.lineAt(0).range.start, open.lineAt(open.lineCount - 1).range.end), content);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('编辑器拒绝恢复操作');
      await open.save();
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async delete(relative: string, workspaceRoot?: string): Promise<void> {
    await vscode.workspace.fs.delete(await this.uri(relative, workspaceRoot), { useTrash: true });
  }

  private async uri(relative: string, workspaceRoot?: string): Promise<vscode.Uri> {
    const root = workspaceRoot || this.roots[0];
    if (!this.roots.some((item) => path.resolve(item).toLowerCase() === path.resolve(root).toLowerCase())) {
      throw new Error('文件不属于当前工作区');
    }
    const absolute = path.resolve(root, relative);
    const back = path.relative(root, absolute);
    if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new Error('文件路径超出工作区');
    }
    const realRoot = await fs.realpath(root);
    let existing = absolute;
    for (;;) {
      try { await fs.lstat(existing); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error('无法定位工作区父目录');
        existing = parent;
      }
    }
    const realExisting = await fs.realpath(existing);
    const actual = path.relative(realRoot, realExisting);
    if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) {
      throw new Error('文件真实路径超出工作区');
    }
    return vscode.Uri.file(absolute);
  }
}
