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
  const { anchor } = request;
  const total = totalRowsOf(request.spans);
  const rows = usableRows(request.rows);
  const furthest = Math.max(0, total - rows);
  if (anchor.kind === "latest") {
    return furthest;
  }
  const index = request.spans.findIndex((span) => span.key === anchor.key);
  if (index === -1) {
    return furthest;
  }
  return clamp(startRowOf(request.spans, index) + anchor.rowOffset, 0, furthest);
}

/** The window a request resolves to. */
export function windowFor(request: WindowRequest): TranscriptWindow {
  const rows = usableRows(request.rows);
  const overscan = Math.max(0, request.overscan ?? DEFAULT_OVERSCAN);
  const total = totalRowsOf(request.spans);
  const top = topRowOf(request);
  const bottom = top + rows;

  let firstVisible = request.spans.length;
  let lastVisible = -1;
  let cursor = 0;
  for (const [index, span] of request.spans.entries()) {
    const end = cursor + span.rows;
    // A zero-row block cannot be visible and must not extend the range: it would
    // make the first and last visible index disagree about an empty span.
    if (span.rows > 0 && end > top && cursor < bottom) {
      firstVisible = Math.min(firstVisible, index);
      lastVisible = index;
    }
    cursor = end;
  }

  if (lastVisible === -1) {
    return {
      firstIndex: 0,
      lastIndex: 0,
      skippedRows: 0,
      visibleRows: 0,
      atLatest: true,
      unseenBlocks: 0,
      totalRows: total,
    };
  }

  const firstIndex = Math.max(0, firstVisible - overscan);
  const lastIndex = Math.min(request.spans.length, lastVisible + 1 + overscan);
  return {
    firstIndex,
    lastIndex,
    // Measured from the first *mounted* block, because that is where the
    // caller's row list begins. Slicing from the first visible block instead
    // would silently drop the overscan it just mounted.
    skippedRows: top - startRowOf(request.spans, firstIndex),
    visibleRows: Math.min(rows, total - top),
    atLatest: top >= Math.max(0, total - rows),
    unseenBlocks: request.spans.length - (lastVisible + 1),
    totalRows: total,
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
  const total = totalRowsOf(request.spans);
  const rows = usableRows(request.rows);
  const furthest = Math.max(0, total - rows);
  const top = clamp(row, 0, furthest);
  if (top >= furthest) {
    return LATEST;
  }

  let cursor = 0;
  for (const span of request.spans) {
    const end = cursor + span.rows;
    if (span.rows > 0 && top < end) {
      return { kind: "pinned", key: span.key, rowOffset: top - cursor };
    }
    cursor = end;
  }
  return LATEST;
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
  const index = request.spans.findIndex((span) => span.key === key);
  if (index === -1) {
    return request.anchor;
  }
  const rows = usableRows(request.rows);
  const start = startRowOf(request.spans, index);
  const end = start + (request.spans[index]?.rows ?? 0);
  const top = topRowOf(request);

  if (start >= top && end <= top + rows) {
    return request.anchor;
  }
  return anchorAt(request, start < top ? start : end - rows);
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
