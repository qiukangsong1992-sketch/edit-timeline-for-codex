import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** 将扫描和快照正文处理留在独立 worker；超时后重建 worker 并显式失败。 */
export class ScanWorker implements vscode.Disposable {
  private worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, PendingRequest>();
  private readonly script: string;
  private readonly storeDir: string;
  private disposed = false;

  constructor(context: vscode.ExtensionContext, storeDir: string) {
    this.script = context.asAbsolutePath(path.join('hook', 'scan-worker.cjs'));
    this.storeDir = storeDir;
    this.worker = this.createWorker();
  }

  request<T>(method: string, args: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('扫描 worker 已关闭'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (this.waiting.has(id)) this.restart(new Error('采集超时'));
        }, Math.max(1, timeoutMs));
      }
      this.waiting.set(id, pending);
      this.worker.postMessage({ id, method, args });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error('扫描 worker 已关闭'));
    void this.worker.terminate();
  }

  private createWorker(): Worker {
    const worker = new Worker(this.script, { workerData: { storeDir: this.storeDir } });
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      if (this.worker !== worker) return;
      const request = this.waiting.get(message.id);
      if (!request) return;
      if (request.timer) clearTimeout(request.timer);
      this.waiting.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    worker.on('error', (error) => {
      if (this.worker === worker && !this.disposed) this.restart(error);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker && !this.disposed) this.restart(new Error(`扫描 worker 已退出：${code}`));
    });
    return worker;
  }

  private restart(error: Error): void {
    const previous = this.worker;
    this.rejectAll(error);
    this.worker = this.createWorker();
    void previous.terminate();
  }

  private rejectAll(error: Error): void {
    for (const request of this.waiting.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.waiting.clear();
  }
}
