/**
 * Incremental heights for the windowed projection.
 *
 * Collapsed height is width-independent, so a long history can be stamped and
 * compared without wrapping. This module reuses a prefix of cached heights when
 * keys and stamps still match, and only materializes a changed suffix — append,
 * a tail revision, or a rebuild from the first mismatch.
 *
 * Materializing is the expensive step (wrapping an expanded block). Stamping
 * every block is a cheap scan; the tests lock the materialize count, which is
 * the work steady-state rendering must not redo over the whole history.
 */

import type { TranscriptRow } from "./rows.ts";

export type HeightKind = "reuse" | "append" | "revise-suffix" | "rebuild";

export type BlockDescriptor = {
  readonly key: string;
  readonly stamp: string;
};

export type HeightRecord = {
  readonly key: string;
  readonly stamp: string;
  readonly rows: number;
  /** Wrapped rows when this block was expanded at measure time; otherwise null. */
  readonly built: readonly TranscriptRow[] | null;
};

export type HeightBatch = {
  readonly records: readonly HeightRecord[];
  /** Times `materialize` ran. Zero on reuse. */
  readonly examined: number;
  readonly kind: HeightKind;
};

export type MaterializedHeight = {
  readonly rows: number;
  readonly built: readonly TranscriptRow[] | null;
};

export const EMPTY_HEIGHT_BATCH: HeightBatch = {
  records: [],
  examined: 0,
  kind: "rebuild",
};

/**
 * Reconcile cached heights with the current descriptors.
 *
 * `materialize(index)` runs only for indices that are new or whose stamp
 * changed. A caller that wraps inside `materialize` therefore wraps only the
 * suffix that actually moved.
 */
export function reconcileHeights(
  previous: HeightBatch | null,
  descriptors: readonly BlockDescriptor[],
  materialize: (index: number) => MaterializedHeight,
): HeightBatch {
  if (descriptors.length === 0) {
    return EMPTY_HEIGHT_BATCH;
  }
  if (previous === null || previous.records.length === 0) {
    return rebuild(descriptors, materialize);
  }

  const prior = previous.records;
  if (descriptors.length < prior.length) {
    return rebuild(descriptors, materialize);
  }

  const shared = prior.length;
  let firstDiff = shared;
  for (let index = 0; index < shared; index += 1) {
    const next = descriptors[index];
    const cached = prior[index];
    if (next === undefined || cached === undefined) {
      return rebuild(descriptors, materialize);
    }
    if (cached.key !== next.key || cached.stamp !== next.stamp) {
      firstDiff = index;
      break;
    }
  }

  if (firstDiff === shared && descriptors.length === shared) {
    return { records: prior, examined: 0, kind: "reuse" };
  }
  if (firstDiff === shared) {
    return extend(prior, descriptors, shared, materialize, "append");
  }
  if (firstDiff === 0) {
    return rebuild(descriptors, materialize);
  }
  return extend(prior, descriptors, firstDiff, materialize, "revise-suffix");
}

function rebuild(
  descriptors: readonly BlockDescriptor[],
  materialize: (index: number) => MaterializedHeight,
): HeightBatch {
  return extend([], descriptors, 0, materialize, "rebuild");
}

function extend(
  prior: readonly HeightRecord[],
  descriptors: readonly BlockDescriptor[],
  from: number,
  materialize: (index: number) => MaterializedHeight,
  kind: HeightKind,
): HeightBatch {
  const records: HeightRecord[] = prior.slice(0, from);
  let examined = 0;
  for (let index = from; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined) {
      continue;
    }
    const materialized = materialize(index);
    records.push({
      key: descriptor.key,
      stamp: descriptor.stamp,
      rows: materialized.rows,
      built: materialized.built,
    });
    examined += 1;
  }
  return { records, examined, kind };
}
