import { describe, expect, test } from 'vitest';
import { toRelativePath } from '../src/core/paths';

describe('toRelativePath', () => {
  test('strips the root on POSIX-style paths', () => {
    expect(toRelativePath('/Users/me/project', '/Users/me/project/src/a.ts')).toBe('src/a.ts');
  });

  test('strips the root on Windows-style paths', () => {
    expect(toRelativePath('C:\\Users\\me\\project', 'C:\\Users\\me\\project\\src\\a.ts')).toBe(
      'src/a.ts',
    );
  });

  test('handles a root that already ends with a separator', () => {
    expect(toRelativePath('/Users/me/project/', '/Users/me/project/a.ts')).toBe('a.ts');
    expect(toRelativePath('C:\\Users\\me\\project\\', 'C:\\Users\\me\\project\\a.ts')).toBe('a.ts');
  });

  test('returns the full path when the target is outside the root', () => {
    expect(toRelativePath('/Users/me/project', '/Users/other/file.ts')).toBe(
      '/Users/other/file.ts',
    );
  });

  test('does not treat a sibling directory with a shared prefix as inside the root', () => {
    expect(toRelativePath('/Users/me/project', '/Users/me/project-other/a.ts')).toBe(
      '/Users/me/project-other/a.ts',
    );
  });

  test('a file directly at the root has no leading separator', () => {
    expect(toRelativePath('/Users/me/project', '/Users/me/project/a.ts')).toBe('a.ts');
  });

  test('normalises Windows separators in the result', () => {
    expect(toRelativePath('C:\\repo', 'C:\\repo\\src\\nested\\file.ts')).toBe(
      'src/nested/file.ts',
    );
  });
});
