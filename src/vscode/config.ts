import * as vscode from 'vscode';
import type { RetentionSettings } from '../core/historyStore';
import type { SnapshotSettings } from '../core/snapshotStore';

export interface Settings extends RetentionSettings, SnapshotSettings {
  maxStorageBytes: number;
  storePrompts: boolean;
  enableStatistics: boolean;
  showStatusBar: boolean;
  exclude: string[];
}

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/target/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**',
  '**/.next/**', '**/.nuxt/**', '**/coverage/**', '**/.cache/**', '**/.idea/**',
];

/** 配置在每次采集时读取，使设置变更直接生效。 */
export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('editTimelineForCodex');
  return {
    maxHistorySessions: config.get('maxHistorySessions', 500),
    autoCleanupDays: config.get('autoCleanupDays', 30),
    maxStorageBytes: config.get('maxStorageBytes', 512 * 1024 * 1024),
    maxSnapshotBytes: config.get('maxSnapshotBytes', 1024 * 1024),
    storePrompts: config.get('storePrompts', true),
    enableStatistics: config.get('enableStatistics', true),
    showStatusBar: config.get('showStatusBar', true),
    exclude: config.get('exclude', DEFAULT_EXCLUDE),
  };
}
