/**
 * The reducer generation, and the cursor a view resumes from.
 *
 * A projection is derived state plus the position it was derived from — the
 * same definition `src/domain/projection.ts` already states, and this module
 * deliberately restates none of its machinery. It borrows the vocabulary
 * (`StreamId`, `Sequence`) and adds the one thing the transcript needs that the
 * stored projections do not have: a generation for a reducer whose output is a
 * view, not a table.
 *
 * **Why the transcript is not in `PROJECTION_NAMES`.** That union names the
 * projections this build *persists*, and each entry implies a cursor row, a
 * rebuild path, and a transaction that advances the two together. The
 * transcript is rebuilt from events every time a view needs it and stored
 * nowhere. Adding it to that union would claim durability that no table backs,
 * and the first person to trust the claim would go looking for the rows. When a
 * durable transcript cursor exists it will arrive with the storage that makes
 * it true.
 *
 * The generation exists for one reason: a cursor recorded under an older
 * reducer describes blocks this build would not produce. Resuming from it would
 * splice two different reducers' output into one transcript, and the seam would
 * be invisible. So a generation mismatch rebuilds instead.
 */

import type { Sequence, StreamId } from "../../domain/index.ts";

/**
 * Raised whenever the reducer's **structural** output for the same events would
 * change: which blocks exist, what each is anchored to, its kind, its status, or
 * the outcome it reports. Adding a kind nothing produces is not a change.
 *
 * Summary wording is deliberately outside the rule, and the boundary is drawn
 * where the replay guard can actually hold it. `./replay.test.ts` records the
 * structural facts and not the strings, because a snapshot that pinned every
 * sentence would fail on a typo fix and teach everyone to update it without
 * reading it — at which point the guard stops guarding anything.
 *
 * The cost of that boundary is real and small: a cursor resumed across a wording
 * change yields a transcript whose older blocks are phrased one way and whose
 * newer blocks are phrased another. That is cosmetic, and nobody can act on it.
 * A structural change is not — it produces blocks a reader would take for
 * something they are not — which is why that half is the half enforced.
 *
 * State the rule no wider than the guard. A module documenting a discipline its
 * own checks do not apply is a comment that is quietly false, and the next
 * person to change a summary will believe they were covered.
 */
export const TRANSCRIPT_PROJECTION_GENERATION = 1;

/** How far one stream has been folded into a transcript. */
export type TranscriptCursor = {
  readonly streamId: StreamId;
  /** Highest sequence applied, or `null` when nothing has been applied yet. */
  readonly lastAppliedSequence: Sequence | null;
  readonly generation: number;
};

/**
 * Whether a cursor may be resumed from rather than rebuilt.
 *
 * Deliberately conservative: anything other than an exact generation match
 * rebuilds. A newer cursor is as unusable as an older one — it describes output
 * from a reducer this build does not contain, and guessing which of the two is
 * compatible is how a downgrade produces a transcript that never existed.
 */
export function resumable(
  cursor: TranscriptCursor,
  generation: number = TRANSCRIPT_PROJECTION_GENERATION,
): boolean {
  return cursor.generation === generation;
}

/** A cursor for a stream nothing has been applied from yet. */
export function initialCursor(
  streamId: StreamId,
  generation: number = TRANSCRIPT_PROJECTION_GENERATION,
): TranscriptCursor {
  return { streamId, lastAppliedSequence: null, generation };
}
