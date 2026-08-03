/**
 * Folding a stream of revisions into a list of blocks.
 *
 * This is the module the streaming contract lives in. A producer that emits a
 * token at a time, or a tool that reports progress before it reports a result,
 * hands over many revisions of one block — and the transcript has to show one
 * thing that changes rather than a row per delta. Appending would turn a
 * hundred-token sentence into a hundred rows, and would put the tool's result
 * somewhere below its own request instead of in place of it.
 *
 * Two invariants make coalescing safe, and both are enforced here rather than
 * hoped for:
 *
 * **Order is first appearance.** A block keeps the position it was first seen
 * at, however many times it is revised afterwards. Without this, a long-running
 * tool call would walk down the transcript every time it reported progress,
 * and a user reading it would lose their place in the only way that matters.
 *
 * **A final block is final.** Once a block has settled, a later revision of it
 * is refused and counted, never applied. This is not defensive tidiness: a
 * delta arriving after a completion — out of order, replayed, or duplicated —
 * would otherwise reopen a finished tool call and erase the outcome it had
 * already reported. Coalescing is allowed to change how often a view repaints.
 * It is not allowed to change what happened.
 *
 * The fold is incremental, so applying revisions one at a time, in frames, or
 * all at once produces the same result. That is what makes "coalescence changes
 * frame frequency, not semantics" a property a test can state.
 */

import type { TranscriptBlock } from "./blocks.ts";
import { blockKey } from "./blocks.ts";

export type CoalescedTranscript = {
  readonly blocks: readonly TranscriptBlock[];
  /**
   * Revisions that arrived for a block that had already settled.
   *
   * Reported rather than silently dropped, and rather than thrown: a duplicate
   * delivery is a fact about the stream, and a transcript that refused to build
   * because of one would be less useful than a transcript that says it saw one.
   */
  readonly refusedRevisions: number;
};

export const EMPTY_TRANSCRIPT: CoalescedTranscript = { blocks: [], refusedRevisions: 0 };

/**
 * Applies one revision.
 *
 * The `order` on the incoming block is ignored for a block that already exists:
 * position belongs to the fold, not to the producer, because a producer emitting
 * a delta has no way to know where the block it is revising ended up.
 */
export function applyRevision(
  state: CoalescedTranscript,
  revision: TranscriptBlock,
): CoalescedTranscript {
  const key = blockKey(revision.anchor);
  const index = state.blocks.findIndex((block) => blockKey(block.anchor) === key);

  if (index === -1) {
    return {
      blocks: [...state.blocks, { ...revision, order: state.blocks.length }],
      refusedRevisions: state.refusedRevisions,
    };
  }

  const existing = state.blocks[index];
  if (existing === undefined || existing.status === "final") {
    return { blocks: state.blocks, refusedRevisions: state.refusedRevisions + 1 };
  }

  const blocks = [...state.blocks];
  blocks[index] = { ...revision, order: existing.order };
  return { blocks, refusedRevisions: state.refusedRevisions };
}

/** Folds a whole run. Identical to applying its revisions one at a time. */
export function coalesce(revisions: readonly TranscriptBlock[]): CoalescedTranscript {
  return revisions.reduce(applyRevision, EMPTY_TRANSCRIPT);
}
