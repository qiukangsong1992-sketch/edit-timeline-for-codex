import { deriveKind } from './fileKind';
import type { AISession, DetectionMethod, FileChange } from './types';

export type MergedSession = Pick<
  AISession,
  'files' | 'endedAt' | 'duration' | 'stats' | 'prompt' | 'pinned' | 'ai' | 'detection'
>;

/** Higher wins, so a merge never downgrades what we know about attribution. */
const FIDELITY: Record<DetectionMethod, number> = { api: 3, marker: 2, manual: 1, burst: 0 };

/**
 * Folds a later session into an earlier one.
 *
 * The earlier session keeps its identity and start time; the result spans until
 * the later session ended. Used when burst detection split what was really one
 * AI interaction.
 */
export function mergeSessions(earlier: AISession, later: AISession): MergedSession {
  const files: FileChange[] = earlier.files.map((file) => ({ ...file }));

  for (const incoming of later.files) {
    const index = files.findIndex((f) => f.path === incoming.path && f.workspaceRoot === incoming.workspaceRoot);
    if (index < 0) {
      files.push({ ...incoming });
      continue;
    }

    const existing = files[index];
    // Existence at the merge's boundaries, not either event's own kind, decides
    // the merged kind — otherwise a delete-then-recreate (or the reverse) across
    // the merge point gets stuck on whichever half happened to run last.
    const existedBefore = existing.kind !== 'create';
    const existsAfter = incoming.kind !== 'delete';
    files[index] = {
      ...existing,
      // Earliest before and latest after, so the diff spans the whole merge.
      beforeRef: existing.beforeRef,
      afterRef: incoming.afterRef ?? existing.afterRef,
      kind: deriveKind(existedBefore, existsAfter),
      snapshot: existing.snapshot,
      added: existing.added + incoming.added,
      deleted: existing.deleted + incoming.deleted,
    };
  }

  const endedAt = Math.max(
    earlier.endedAt ?? earlier.startedAt,
    later.endedAt ?? later.startedAt,
  );

  const preferLater = FIDELITY[later.detection] > FIDELITY[earlier.detection];

  return {
    files,
    endedAt,
    duration: endedAt - earlier.startedAt,
    stats: files.reduce(
      (total, file) => ({ added: total.added + file.added, deleted: total.deleted + file.deleted }),
      { added: 0, deleted: 0 },
    ),
    prompt: [earlier.prompt, later.prompt].filter(Boolean).join(' · ') || undefined,
    pinned: earlier.pinned || later.pinned || undefined,
    ai: preferLater ? later.ai : earlier.ai,
    detection: preferLater ? later.detection : earlier.detection,
  };
}
