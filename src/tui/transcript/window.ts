/**
 * The bounded window, and the anchor that decides where it sits.
 *
 * A transcript is unbounded and a terminal is not, so something has to decide
 * which part of the history is mounted. This module is that decision, expressed
 * as a pure function of block heights, a row budget, and an anchor — no
 * renderer, no React, no measurement of its own.
 *
 * Two properties are the point.
 *
 * **A user who scrolls away is never yanked back.** The anchor is a closed union
 * with exactly two states: following the latest, or pinned to a named block at a
 * row offset inside it. New blocks move the content under a `latest` anchor and
 * leave a `pinned` one exactly where it was. That is a structural guarantee
 * rather than a comparison of scroll offsets against a threshold, and it is why
 * arriving activity cannot steal a reader's place mid-sentence.
 *
 * **Placing the window does not walk the history.** Heights live in a prefix-sum
 * index, so the visible range is a binary search over those sums. Measuring
 * every collapsed block is still a cheap stamp; wrapping and row materialization
 * stay on the changed suffix and the mounted window.
 *
 * **A pin survives a resize and an overlay.** The pin names a *block*, not a row
 * index and not a pixel offset, so re-wrapping the content it is pinned to
 * changes how tall that block is without changing which block the reader is
 * looking at. An overlay does not touch this state at all — it is held above the
 * measurement, for the same reason `AppShell` holds the theme above it.
 *
 * A pin to a block that is no longer in the projection resolves to the latest
 * rather than to nothing: a transcript can only lose a block by being rebuilt,
 * and refusing to render until the reader scrolls would be a worse answer than
 * showing them the end.
 */

/** One block's identity and how many rows it occupies at the current width. */
export type BlockSpan = {
  readonly key: string;
  readonly rows: number;
};

/**
 * Prefix sums over block heights, so placing a window does not walk the history.
 *
 * `prefix[i]` is the row at which span `i` starts. `prefix[length]` is the total.
 * `byKey` records the first index of each key, matching `findIndex`.
 */
export type SpanIndex = {
  readonly spans: readonly BlockSpan[];
  readonly prefix: readonly number[];
  readonly byKey: ReadonlyMap<string, number>;
  readonly total: number;
};

export function spanIndexOf(spans: readonly BlockSpan[]): SpanIndex {
  const prefix: number[] = [0];
  const byKey = new Map<string, number>();
  for (const [index, span] of spans.entries()) {
    if (!byKey.has(span.key)) {
      byKey.set(span.key, index);
    }
    prefix.push((prefix[index] ?? 0) + Math.max(0, span.rows));
  }
  return { spans, prefix, byKey, total: prefix[prefix.length - 1] ?? 0 };
}

/**
 * Where the window sits.
 *
 * `latest` is not "pinned to the last block": a transcript whose last block is
 * growing must keep showing its newest rows, and a pin to that block would stop
 * at whatever height it had when the pin was taken.
 */
export type TranscriptAnchor =
  | { readonly kind: "latest" }
  | { readonly kind: "pinned"; readonly key: string; readonly rowOffset: number };

export const LATEST: TranscriptAnchor = { kind: "latest" };

/**
 * Blocks mounted beyond the visible edge, each side.
 *
 * Small and deliberately not zero. Overscan is what makes a one-row scroll a
 * re-slice rather than a first measurement of a block nobody had looked at, and
 * it is bounded so "a very large history stays bounded" survives it.
 */
export const DEFAULT_OVERSCAN = 2;

export type WindowRequest = {
  readonly spans: readonly BlockSpan[];
  /** Rows the surface may draw into. Never a substituted default. */
  readonly rows: number;
  readonly anchor: TranscriptAnchor;
  readonly overscan?: number;
};

export type TranscriptWindow = {
  /** First mounted block, including overscan. */
  readonly firstIndex: number;
  /** One past the last mounted block, including overscan. */
  readonly lastIndex: number;
  /** Rows of the mounted range that sit above the visible region. */
  readonly skippedRows: number;
  /** Rows the visible region actually holds. Never more than the budget. */
  readonly visibleRows: number;
  /** Whether the window is showing the end of the transcript. */
  readonly atLatest: boolean;
  /** Blocks entirely below the visible region — the unseen activity. */
  readonly unseenBlocks: number;
  readonly totalRows: number;
};

/**
 * Where the window's top row sits, in rows from the start of the transcript.
 *
 * Clamped to the transcript rather than trusted: a pin taken before a block
 * shrank, or before the terminal grew, would otherwise place the window past
 * content that no longer exists.
 */
export function topRowOf(request: WindowRequest): number {
  return topRowOn(spanIndexOf(request.spans), request.rows, request.anchor);
}

/** The window a request resolves to. */
export function windowFor(request: WindowRequest): TranscriptWindow {
  return windowOn(spanIndexOf(request.spans), request.rows, request.anchor, request.overscan);
}

/** `topRowOf` when the caller already holds an index. */
export function topRowOn(index: SpanIndex, rows: number, anchor: TranscriptAnchor): number {
  const budget = usableRows(rows);
  const furthest = Math.max(0, index.total - budget);
  if (anchor.kind === "latest") {
    return furthest;
  }
  const at = index.byKey.get(anchor.key);
  if (at === undefined) {
    return furthest;
  }
  return clamp((index.prefix[at] ?? 0) + anchor.rowOffset, 0, furthest);
}

/** `windowFor` when the caller already holds an index. */
export function windowOn(
  index: SpanIndex,
  rows: number,
  anchor: TranscriptAnchor,
  overscan = DEFAULT_OVERSCAN,
): TranscriptWindow {
  const budget = usableRows(rows);
  const extra = Math.max(0, overscan);
  const top = topRowOn(index, budget, anchor);
  const bottom = top + budget;
  const firstVisible = firstEndingAfter(index, top);
  const lastVisible = lastStartingBefore(index, bottom);

  if (
    firstVisible >= index.spans.length ||
    lastVisible < 0 ||
    firstVisible > lastVisible ||
    !overlaps(index, firstVisible, top, bottom) ||
    !overlaps(index, lastVisible, top, bottom)
  ) {
    return {
      firstIndex: 0,
      lastIndex: 0,
      skippedRows: 0,
      visibleRows: 0,
      atLatest: true,
      unseenBlocks: 0,
      totalRows: index.total,
    };
  }

  const firstIndex = Math.max(0, firstVisible - extra);
  const lastIndex = Math.min(index.spans.length, lastVisible + 1 + extra);
  return {
    firstIndex,
    lastIndex,
    skippedRows: top - (index.prefix[firstIndex] ?? 0),
    visibleRows: Math.min(budget, index.total - top),
    atLatest: top >= Math.max(0, index.total - budget),
    unseenBlocks: index.spans.length - (lastVisible + 1),
    totalRows: index.total,
  };
}

/**
 * The anchor produced by scrolling.
 *
 * Scrolling to the end returns to `latest` rather than pinning the last block,
 * so a reader who scrolls back down starts following again — which is what
 * "jump to latest" has to mean for the indicator to ever go away.
 */
export function scrolledBy(request: WindowRequest, delta: number): TranscriptAnchor {
  return anchorAt(request, topRowOf(request) + delta);
}

/** The anchor for an absolute top row. */
export function anchorAt(request: WindowRequest, row: number): TranscriptAnchor {
  return anchorOn(spanIndexOf(request.spans), request.rows, row);
}

/** `anchorAt` when the caller already holds an index. */
export function anchorOn(index: SpanIndex, rows: number, row: number): TranscriptAnchor {
  const budget = usableRows(rows);
  const furthest = Math.max(0, index.total - budget);
  const top = clamp(row, 0, furthest);
  if (top >= furthest) {
    return LATEST;
  }
  const at = firstEndingAfter(index, top);
  const span = index.spans[at];
  const start = index.prefix[at];
  if (span === undefined || start === undefined || span.rows <= 0) {
    return LATEST;
  }
  return { kind: "pinned", key: span.key, rowOffset: top - start };
}

/**
 * An anchor that keeps a named block visible.
 *
 * The rule the layout contract states for a resize — scroll offsets may move to
 * keep the selected item visible — applied to selection as well, because a
 * selection the reader cannot see is a selection they will act on blind. A block
 * already fully visible is left alone rather than centred: moving the view for
 * something that was already on screen is the yanking this module exists to
 * prevent.
 */
export function anchorRevealing(request: WindowRequest, key: string): TranscriptAnchor {
  const index = spanIndexOf(request.spans);
  const at = index.byKey.get(key);
  if (at === undefined) {
    return request.anchor;
  }
  const budget = usableRows(request.rows);
  const start = index.prefix[at] ?? 0;
  const end = start + (index.spans[at]?.rows ?? 0);
  const top = topRowOn(index, budget, request.anchor);

  if (start >= top && end <= top + budget) {
    return request.anchor;
  }
  return anchorOn(index, budget, start < top ? start : end - budget);
}

/** Total rows the whole transcript would occupy. */
export function totalRowsOf(spans: readonly BlockSpan[]): number {
  let total = 0;
  for (const span of spans) {
    total += Math.max(0, span.rows);
  }
  return total;
}

/** Rows before the block at `index`. */
export function startRowOf(spans: readonly BlockSpan[], index: number): number {
  let start = 0;
  for (const [position, span] of spans.entries()) {
    if (position >= index) {
      break;
    }
    start += Math.max(0, span.rows);
  }
  return start;
}

/**
 * A row budget the window is willing to reason about.
 *
 * Zero, negative, fractional, and `NaN` all resolve to zero, for the reason
 * `selectLayout` gives: a terminal genuinely reports nothing during a resize,
 * and a `NaN` reaching a comparison makes every one of them false.
 */
function usableRows(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Smallest span whose exclusive end is after `row`. */
function firstEndingAfter(index: SpanIndex, row: number): number {
  const count = index.spans.length;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((index.prefix[mid + 1] ?? 0) > row) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

/** Largest span whose start is before `row`. */
function lastStartingBefore(index: SpanIndex, row: number): number {
  const count = index.spans.length;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((index.prefix[mid] ?? 0) < row) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low - 1;
}

function overlaps(index: SpanIndex, at: number, top: number, bottom: number): boolean {
  const span = index.spans[at];
  const start = index.prefix[at] ?? 0;
  if (span === undefined || span.rows <= 0) {
    return false;
  }
  return start + span.rows > top && start < bottom;
}
