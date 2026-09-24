import type { Disposable } from './types';

/**
 * Minimal event emitter so core modules stay free of any `vscode` import.
 * A throwing listener never prevents the others from running.
 */
export class Emitter<T> {
  private listeners: ((value: T) => void)[] = [];

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A misbehaving listener must not break the pipeline.
      }
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}
