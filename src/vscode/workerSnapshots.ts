import type { CaptureOutcome, SnapshotStore } from '../core/types';
import type { ScanWorker } from './workerClient';

/** Blob 由 worker 哈希、压缩和解压；历史引用在成功提交后统一校验。 */
export class WorkerSnapshots implements SnapshotStore {
  private readonly fresh = new Set<string>();

  constructor(
    private readonly worker: ScanWorker,
    private readonly maxBytes: () => number,
    private readonly maxStorageBytes: () => number,
  ) {}

  async put(content: string): Promise<CaptureOutcome> {
    if (content.includes('\0')) return { state: 'binary' };
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes()) return { state: 'too-large' };
    const ref = await this.worker.request<string | undefined>('put', { text: content, limitBytes: this.maxStorageBytes() });
    if (!ref) return { state: 'unavailable' };
    this.fresh.add(ref);
    return { state: 'captured', ref };
  }

  get(ref: string): Promise<string | undefined> {
    return this.worker.request('get', { ref });
  }

  async release(_refs: string[]): Promise<void> {
    // 历史提交后的批量校验负责删除，避免并发采集仍在使用时提前物理删除。
  }

  async clear(): Promise<void> {
    await this.reconcile([]);
  }

  async reconcile(historyRefs: string[]): Promise<Record<string, number>> {
    const inHistory = new Set(historyRefs);
    const refs = [...historyRefs, ...[...this.fresh].filter((ref) => !inHistory.has(ref))];
    const counts = await this.worker.request<Record<string, number>>('reconcile', { refs });
    for (const ref of historyRefs) this.fresh.delete(ref);
    return counts;
  }
}
