/**
 * The subset of glob syntax VS Code exclude settings actually use:
 * `**`, `*`, `?` and `{a,b}` alternatives.
 *
 * Written by hand rather than pulled in as a dependency: this runs on every file
 * event, and the surface is small enough to test exhaustively.
 */

const cache = new Map<string, RegExp | undefined>();

export function matchesGlob(path: string, pattern: string): boolean {
  const regexp = compile(pattern);
  return regexp ? regexp.test(path) : false;
}

export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function compile(pattern: string): RegExp | undefined {
  if (cache.has(pattern)) {
    return cache.get(pattern);
  }

  let regexp: RegExp | undefined;
  try {
    regexp = new RegExp(`^${translate(pattern)}$`);
  } catch {
    // A malformed pattern must not break file tracking; it simply matches nothing.
    regexp = undefined;
  }
  cache.set(pattern, regexp);
  return regexp;
}

function translate(pattern: string): string {
  let out = '';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` spans any number of leading directories, including none.
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      continue;
    }

    if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close > i) {
        const alternatives = pattern.slice(i + 1, close).split(',');
        out += `(?:${alternatives.map(translate).join('|')})`;
        i = close;
        continue;
      }
    }

    out += escapeLiteral(char);
  }

  return out;
}

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}
