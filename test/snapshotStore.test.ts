import { beforeEach, describe, expect, test } from 'vitest';
import { BlobSnapshotStore, type BlobFileSystem } from '../src/core/snapshotStore';
import type { KeyValueStore } from '../src/core/historyStore';

class FakeBlobFs implements BlobFileSystem {
  files = new Map<string, Uint8Array>();
  failWrites = false;
  failReads = false;

  async read(name: string): Promise<Uint8Array | undefined> {
    if (this.failReads) {
      throw new Error('disk read error');
    }
    return this.files.get(name);
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    if (this.failWrites) {
      throw new Error('disk full');
    }
    this.files.set(name, data);
  }

  async delete(name: string): Promise<void> {
    this.files.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async clear(): Promise<void> {
    this.files.clear();
  }
}

class FakeMemento implements KeyValueStore {
  data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
  }
}

describe('BlobSnapshotStore', () => {
  let fs: FakeBlobFs;
  let memento: FakeMemento;
  let maxBytes: number;

  function build() {
    return new BlobSnapshotStore({
      fs,
      memento,
      settings: () => ({ maxSnapshotBytes: maxBytes }),
    });
  }

  beforeEach(() => {
    fs = new FakeBlobFs();
    memento = new FakeMemento();
    maxBytes = 1_048_576;
  });

  test('round-trips content', async () => {
    const store = build();
    const outcome = await store.put('hello\nworld');

    expect(outcome.state).toBe('captured');
    expect(await store.get((outcome as { ref: string }).ref)).toBe('hello\nworld');
  });

  test('round-trips multi-byte characters', async () => {
    const store = build();
    const content = 'const naïve = "日本語 🎉";\n';
    const outcome = await store.put(content);

    expect(await store.get((outcome as { ref: string }).ref)).toBe(content);
  });

  test('round-trips an empty file', async () => {
    const store = build();
    const outcome = await store.put('');

    expect(outcome.state).toBe('captured');
    expect(await store.get((outcome as { ref: string }).ref)).toBe('');
  });

  test('stores identical content once', async () => {
    const store = build();
    const first = await store.put('same');
    const second = await store.put('same');

    expect(first).toEqual(second);
    expect(fs.files.size).toBe(1);
  });

  test('different content gets different refs', async () => {
    const store = build();
    const a = await store.put('one');
    const b = await store.put('two');

    expect(a).not.toEqual(b);
    expect(fs.files.size).toBe(2);
  });

  test('keeps a blob alive while another session still references it', async () => {
    const store = build();
    const { ref } = (await store.put('shared')) as { ref: string };
    await store.put('shared');

    await store.release([ref]);

    expect(await store.get(ref)).toBe('shared');
  });

  test('deletes a blob once its last reference is released', async () => {
    const store = build();
    const { ref } = (await store.put('doomed')) as { ref: string };
    await store.put('doomed');

    await store.release([ref, ref]);

    expect(await store.get(ref)).toBeUndefined();
    expect(fs.files.size).toBe(0);
  });

  test('releasing an unknown ref is harmless', async () => {
    const store = build();
    await expect(store.release(['nope'])).resolves.toBeUndefined();
  });

  test('refuses content over the size cap and writes nothing', async () => {
    maxBytes = 32;
    const store = build();

    expect(await store.put('x'.repeat(100))).toEqual({ state: 'too-large' });
    expect(fs.files.size).toBe(0);
  });

  test('measures the size cap in bytes, not characters', async () => {
    maxBytes = 8;
    const store = build();

    // Six characters, but eighteen bytes in UTF-8.
    expect(await store.put('日本語日本語')).toEqual({ state: 'too-large' });
  });

  test('refuses binary content', async () => {
    const store = build();

    expect(await store.put('PK\u0000\u0000binary')).toEqual({ state: 'binary' });
    expect(fs.files.size).toBe(0);
  });

  test('reports unavailable rather than throwing when the disk write fails', async () => {
    fs.failWrites = true;
    const store = build();

    expect(await store.put('content')).toEqual({ state: 'unavailable' });
  });

  test('returns undefined rather than throwing when the disk read fails', async () => {
    const store = build();
    const { ref } = (await store.put('content')) as { ref: string };
    fs.failReads = true;

    expect(await store.get(ref)).toBeUndefined();
  });

  test('returns undefined for an unknown ref', async () => {
    expect(await build().get('deadbeef')).toBeUndefined();
  });

  test('clear removes every blob and forgets every reference', async () => {
    const store = build();
    await store.put('a');
    await store.put('b');

    await store.clear();

    expect(fs.files.size).toBe(0);
    expect(await store.put('a')).toMatchObject({ state: 'captured' });
    expect(fs.files.size).toBe(1);
  });

  test('reference counts survive a restart', async () => {
    const first = build();
    const { ref } = (await first.put('persisted')) as { ref: string };
    await first.put('persisted');

    const second = build();
    await second.release([ref]);

    expect(await second.get(ref)).toBe('persisted');

    await second.release([ref]);
    expect(await second.get(ref)).toBeUndefined();
  });

  test('reclaims blobs on disk that no session references any more', async () => {
    const store = build();
    const { ref } = (await store.put('kept')) as { ref: string };
    fs.files.set('orphan-blob', new Uint8Array([1, 2, 3]));

    await store.collectGarbage([ref]);

    expect(fs.files.has('orphan-blob')).toBe(false);
    expect(await store.get(ref)).toBe('kept');
  });
});
