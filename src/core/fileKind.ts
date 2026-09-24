import type { ChangeKind } from './types';

/**
 * Derives a file's session-level kind from whether it existed at the session's
 * start versus now — rather than trusting the most recent watcher event, which
 * gets it wrong across a delete-then-recreate (or create-then-delete) within one
 * session.
 */
export function deriveKind(existedBefore: boolean, existsAfter: boolean): ChangeKind {
  if (existedBefore && !existsAfter) {
    return 'delete';
  }
  if (!existedBefore && existsAfter) {
    return 'create';
  }
  if (existedBefore && existsAfter) {
    return 'change';
  }
  // Never existed, still doesn't: a net no-op. Labelling it 'create' means an
  // undo deletes a path that is already gone — safe — rather than 'delete',
  // which would write an unwanted empty file back into existence.
  return 'create';
}
