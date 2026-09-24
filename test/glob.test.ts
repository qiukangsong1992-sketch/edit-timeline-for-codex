import { describe, expect, test } from 'vitest';
import { isExcluded, matchesGlob } from '../src/core/glob';

describe('matchesGlob', () => {
  test('**/dir/** matches the directory at any depth', () => {
    expect(matchesGlob('node_modules/react/index.js', '**/node_modules/**')).toBe(true);
    expect(matchesGlob('packages/web/node_modules/react/index.js', '**/node_modules/**')).toBe(true);
  });

  test('**/dir/** does not match a similarly named path', () => {
    expect(matchesGlob('src/node_modules_helper.ts', '**/node_modules/**')).toBe(false);
    expect(matchesGlob('src/distribution/index.ts', '**/dist/**')).toBe(false);
  });

  test('**/*.ext matches the extension at any depth', () => {
    expect(matchesGlob('debug.log', '**/*.log')).toBe(true);
    expect(matchesGlob('logs/nested/debug.log', '**/*.log')).toBe(true);
    expect(matchesGlob('debug.log.ts', '**/*.log')).toBe(false);
  });

  test('**/name matches a bare filename at any depth', () => {
    expect(matchesGlob('.DS_Store', '**/.DS_Store')).toBe(true);
    expect(matchesGlob('src/assets/.DS_Store', '**/.DS_Store')).toBe(true);
  });

  test('a single star does not cross a path separator', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/nested/a.ts', 'src/*.ts')).toBe(false);
  });

  test('a question mark matches exactly one character', () => {
    expect(matchesGlob('a.ts', '?.ts')).toBe(true);
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false);
  });

  test('dots are literal, not wildcards', () => {
    expect(matchesGlob('.git/config', '**/.git/**')).toBe(true);
    expect(matchesGlob('xgit/config', '**/.git/**')).toBe(false);
  });

  test('braces offer alternatives', () => {
    expect(matchesGlob('out/main.js', '**/{dist,out}/**')).toBe(true);
    expect(matchesGlob('dist/main.js', '**/{dist,out}/**')).toBe(true);
    expect(matchesGlob('src/main.js', '**/{dist,out}/**')).toBe(false);
  });

  test('matching is case sensitive, like the paths it filters', () => {
    expect(matchesGlob('SRC/a.ts', 'src/*.ts')).toBe(false);
  });
});

describe('isExcluded', () => {
  const defaults = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/__pycache__/**',
    '**/*.log',
    '**/.DS_Store',
  ];

  test('excludes the paths the defaults are meant to catch', () => {
    for (const path of [
      'node_modules/lodash/index.js',
      '.git/HEAD',
      'dist/bundle.js',
      'api/__pycache__/views.cpython-311.pyc',
      'npm-debug.log',
      'src/.DS_Store',
    ]) {
      expect(isExcluded(path, defaults), path).toBe(true);
    }
  });

  test('leaves real source files alone', () => {
    for (const path of [
      'src/auth.ts',
      'src/components/Login.tsx',
      'api/views.py',
      'README.md',
      'packages/dist-utils/index.ts',
    ]) {
      expect(isExcluded(path, defaults), path).toBe(false);
    }
  });

  test('an empty pattern list excludes nothing', () => {
    expect(isExcluded('node_modules/x.js', [])).toBe(false);
  });

  test('an invalid pattern is ignored rather than throwing', () => {
    expect(() => isExcluded('src/a.ts', ['['])).not.toThrow();
  });
});
