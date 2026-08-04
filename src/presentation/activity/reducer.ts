/**
 * Scope events, folded into the rail's projection.
 *
 * A projection is derived state plus the position it was derived from, which is
 * the definition `src/domain/projection.ts` already states and the one this
 * follows. The position here is a scope event's `order` — monotonic across the
 * whole tree, so interleaved scopes stay orderable and a cursor names an exact
 * point rather than a wall-clock moment.
 *
 * ## Resubscription is the reason this is a fold rather than a snapshot
 *
 * The rail could be rebuilt from `ScopeTree.report()` on every frame, and for a
 * live runtime that would even be correct. It would also make "resubscribe
 * without restarting the runtime" untestable and, worse, unmeaning: a view that
 * only ever asks for *now* has nothing to resume from, so a renderer that
 * dropped and came back would silently start its history at the moment it
 * returned. Folding from a cursor is what lets a view come back and be missing
 * nothing.
 *
 * Applying the same events twice produces the same projection, and applying a
 * suffix to a projection produces what folding the whole sequence would. Both
 * are asserted rather than assumed — they are the properties a resubscribe
 * depends on.
 *
 * Pure: no clock, no renderer, no storage, no runtime handle. Nothing here can
 * restart anything, which is the strongest form the acceptance criterion can
 * take.
 */

import type { ScopeEvent } from "../../domain/index.ts";
import { type ActivityEntry, entryForEvent, foldEntry, isLive } from "./entries.ts";

/**
 * Raised whenever the fold's structural output for the same events would change:
 * which entries exist, what each is keyed by, its lifecycle, or the outcome it
 * reports. Wording is outside the rule, for the reason the transcript's own
 * generation states at length.
 */
export const ACTIVITY_PROJECTION_GENERATION = 1;

/**
 * How far the rail has been folded.
 *
 * `lastAppliedOrder` rather than a timestamp: two events in the same
 * millisecond are ordered by the tree and not by the clock, and a cursor that
 * could not tell them apart would replay one or drop one on every resume.
 */
export type ActivityCursor = {
  readonly lastAppliedOrder: number | null;
  readonly generation: number;
};

export function initialActivityCursor(
  generation: number = ACTIVITY_PROJECTION_GENERATION,
): ActivityCursor {
  return { lastAppliedOrder: null, generation };
}

/**
 * Whether a cursor may be resumed from rather than rebuilt.
 *
 * Deliberately conservative, and identical in shape to the transcript's rule
 * because it guards the same failure: a cursor recorded under a different
 * generation describes entries this build would not produce, and resuming from
 * it splices two reducers' output into one rail with an invisible seam. A newer
 * cursor is as unusable as an older one.
 */
export function resumableActivity(
  cursor: ActivityCursor,
  generation: number = ACTIVITY_PROJECTION_GENERATION,
): boolean {
  return cursor.generation === generation;
}

/**
 * Entries the rail keeps for work that has already settled.
 *
 * Bounded, because a long session settles a great many scopes and a rail is a
 * view of what is happening rather than a log of what happened. Live work is
 * never evicted: an interface that dropped a running operation to make room for
 * a finished one would hide the thing the rail exists to show.
 */
export const MAX_SETTLED_ENTRIES = 50;

export type ActivityProjection = {
  /** In `order`, oldest first. Live work and a bounded tail of settled work. */
  readonly entries: readonly ActivityEntry[];
  readonly cursor: ActivityCursor;
  /**
   * Settled entries dropped to stay within the bound.
   *
   * Carried so the rail can say "and 12 more finished" rather than quietly
   * presenting a truncated list as a complete one.
   */
  readonly droppedSettled: number;
};

export const EMPTY_ACTIVITY: ActivityProjection = {
  entries: [],
  cursor: initialActivityCursor(),
  droppedSettled: 0,
};

/**
 * Applies events to a projection.
 *
 * Events at or before the cursor are skipped rather than rejected: a
 * resubscribing view has no way to know exactly where the stream will restart,
 * and refusing an overlap would make the caller responsible for a slice it
 * cannot compute. Out-of-order events are skipped by the same rule, which makes
 * the fold idempotent under replay.
 */
export function reduceActivity(
  projection: ActivityProjection,
  events: readonly ScopeEvent[],
): ActivityProjection {
  let cursor = projection.cursor.lastAppliedOrder;
  const byKey = new Map(projection.entries.map((entry) => [entry.key, entry]));
  let applied = false;

  for (const event of events) {
    if (cursor !== null && event.order <= cursor) {
      continue;
    }
    const next = entryForEvent(event);
    const previous = byKey.get(next.key);
    byKey.set(next.key, previous === undefined ? next : foldEntry(previous, next));
    cursor = event.order;
    applied = true;
  }

  if (!applied) {
    return projection;
  }

  const ordered = [...byKey.values()].sort((left, right) => left.order - right.order);
  const bounded = bound(ordered);

  return {
    entries: bounded.entries,
    cursor: { ...projection.cursor, lastAppliedOrder: cursor },
    droppedSettled: projection.droppedSettled + bounded.dropped,
  };
}

/**
 * Every live entry, and the newest settled ones.
 *
 * The oldest settled entries go first, which is the only eviction order that
 * keeps the rail showing what just happened rather than what happened first.
 */
function bound(entries: readonly ActivityEntry[]): {
  readonly entries: readonly ActivityEntry[];
  readonly dropped: number;
} {
  const settled = entries.filter((entry) => !isLive(entry));
  if (settled.length <= MAX_SETTLED_ENTRIES) {
    return { entries, dropped: 0 };
  }
  const dropped = settled.length - MAX_SETTLED_ENTRIES;
  const evicted = new Set(settled.slice(0, dropped).map((entry) => entry.key));
  return { entries: entries.filter((entry) => !evicted.has(entry.key)), dropped };
}

/**
 * A projection resumed from a cursor, or a rebuild when it cannot be.
 *
 * The one function a resubscribing view calls. It answers both halves of the
 * question — whether this cursor is usable, and what to do about it — so a
 * caller cannot check the generation and then forget to act on the answer.
 *
 * Nothing here touches the runtime. Resubscription is a view rebuilding its own
 * derived state, and the strongest way to guarantee it does not restart
 * anything is that this module holds nothing it could restart.
 */
export function resubscribeActivity(
  cursor: ActivityCursor,
  events: readonly ScopeEvent[],
): { readonly projection: ActivityProjection; readonly rebuilt: boolean } {
  if (!resumableActivity(cursor)) {
    // Rebuilt from the whole sequence under this build's generation. The stale
    // cursor is discarded rather than repaired: a cursor from another generation
    // names a position in output this build does not produce.
    return { projection: reduceActivity(EMPTY_ACTIVITY, events), rebuilt: true };
  }
  return {
    projection: reduceActivity({ ...EMPTY_ACTIVITY, cursor }, events),
    rebuilt: false,
  };
}

/** Live entries, in order. What the rail shows first. */
export function liveEntries(projection: ActivityProjection): readonly ActivityEntry[] {
  return projection.entries.filter(isLive);
}

/** Settled entries, newest last. What the rail shows underneath. */
export function settledEntries(projection: ActivityProjection): readonly ActivityEntry[] {
  return projection.entries.filter((entry) => !isLive(entry));
}
