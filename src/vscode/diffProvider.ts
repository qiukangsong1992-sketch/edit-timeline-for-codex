import * as vscode from 'vscode';
import type { SnapshotStore } from '../core/types';

export const SNAPSHOT_SCHEME = 'edit-timeline-for-codex';

/** 快照 URI 携带内容哈希；文件后续再变动时，历史差异仍指向当时的正文。 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly snapshots: SnapshotStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = new URLSearchParams(uri.query).get('ref');
    if (!ref) {
      return '';
    }
    const content = await this.snapshots.get(ref);
    return content ?? '';
  }
}

/** `edit-timeline-for-codex:/<path>?ref=<blob>` — 路径用于显示，正文由快照引用定位。 */
export function snapshotUri(path: string, ref: string, label: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `/${label}/${path}`,
    query: new URLSearchParams({ ref }).toString(),
  });
}
