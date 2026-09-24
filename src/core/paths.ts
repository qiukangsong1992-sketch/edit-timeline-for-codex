/**
 * Converts an absolute filesystem path to one relative to a root, forward-slashed.
 *
 * Both sides are normalised to forward slashes *before* comparison. Comparing
 * with the platform separator baked in (as a naive implementation would) breaks
 * on Windows: `Uri.fsPath` there is backslash-separated, so a root path never
 * ends with `/`, appending one produces a string with mixed separators, and the
 * prefix check against an all-backslash target then always fails — silently
 * falling back to the absolute path for every file, which breaks exclude globs,
 * cross-session path lookups, and URI construction alike.
 */
export function toRelativePath(rootFsPath: string, targetFsPath: string): string {
  const root = normalise(rootFsPath);
  const target = normalise(targetFsPath);

  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!target.startsWith(prefix)) {
    return target;
  }
  return target.slice(prefix.length);
}

function normalise(fsPath: string): string {
  return fsPath.split('\\').join('/');
}
