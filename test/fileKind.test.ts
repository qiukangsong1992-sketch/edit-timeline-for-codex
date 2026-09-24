import { describe, expect, test } from 'vitest';
import { deriveKind } from '../src/core/fileKind';

describe('deriveKind', () => {
  test('a file that existed before and still exists after is a change', () => {
    expect(deriveKind(true, true)).toBe('change');
  });

  test('a file that did not exist before but exists after is a create', () => {
    expect(deriveKind(false, true)).toBe('create');
  });

  test('a file that existed before and no longer exists is a delete', () => {
    expect(deriveKind(true, false)).toBe('delete');
  });

  test('a file created then deleted within the same session nets to a no-op create', () => {
    // Never existed before, doesn't exist after — restoring must delete, not
    // write an empty file back into existence, so this reads as 'create'.
    expect(deriveKind(false, false)).toBe('create');
  });
});
