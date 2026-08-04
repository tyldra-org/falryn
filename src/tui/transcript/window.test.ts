/**
 * The window, the anchor, and the promise not to move someone's place.
 *
 * These are the assertions that make "a large history renders in a bounded
 * window" and "a user who scrolls away is not yanked back" checkable facts
 * rather than intentions. Every one of them runs without a terminal, because
 * the whole decision is arithmetic over block heights.
 */

import { describe, expect, test } from "bun:test";
import {
  anchorAt,
  anchorRevealing,
  type BlockSpan,
  DEFAULT_OVERSCAN,
  LATEST,
  scrolledBy,
  startRowOf,
  topRowOf,
  totalRowsOf,
  windowFor,
} from "./window.ts";

/** A history of uniform blocks, which makes every expected row easy to state. */
function spans(count: number, rows = 2): readonly BlockSpan[] {
  return Array.from({ length: count }, (_unused, index) => ({ key: `b${index}`, rows }));
}

describe("a transcript shorter than its region", () => {
  test("shows everything and is at the latest", () => {
    const view = windowFor({ spans: spans(3), rows: 40, anchor: LATEST });
    expect(view.firstIndex).toBe(0);
    expect(view.lastIndex).toBe(3);
    expect(view.skippedRows).toBe(0);
    expect(view.visibleRows).toBe(6);
    expect(view.atLatest).toBe(true);
    expect(view.unseenBlocks).toBe(0);
  });
});

describe("a very large history", () => {
  test("mounts a window bounded by the region rather than by the history", () => {
    // The acceptance criterion, stated as a number. Ten thousand blocks, twenty
    // rows: what is mounted is a function of the terminal.
    const view = windowFor({ spans: spans(10_000), rows: 20, anchor: LATEST });
    const mounted = view.lastIndex - view.firstIndex;
    expect(mounted).toBeLessThanOrEqual(20 / 2 + DEFAULT_OVERSCAN * 2);
    expect(view.visibleRows).toBe(20);
    expect(view.totalRows).toBe(20_000);
  });

  test("stays bounded however tall the individual blocks are", () => {
    const tall = spans(5_000, 40);
    const view = windowFor({ spans: tall, rows: 20, anchor: LATEST });
    expect(view.lastIndex - view.firstIndex).toBeLessThanOrEqual(1 + DEFAULT_OVERSCAN * 2);
  });

  test("mounts more than it shows, so a one-row scroll is a re-slice", () => {
    // What overscan buys. The window sits in the middle, so both sides have
    // room for it.
    const all = spans(1_000);
    const anchor = anchorAt({ spans: all, rows: 20, anchor: LATEST }, 500);
    const view = windowFor({ spans: all, rows: 20, anchor });
    expect(view.firstIndex).toBeLessThan(500 / 2);
    expect(view.lastIndex).toBeGreaterThan(500 / 2 + 20 / 2);
  });
});

describe("following the latest", () => {
  test("moves with new blocks rather than staying on the last one", () => {
    // The distinction the anchor union exists for: `latest` is not a pin to the
    // final block, so a block that grows keeps its newest rows on screen.
    const before = windowFor({ spans: spans(50), rows: 10, anchor: LATEST });
    const after = windowFor({ spans: spans(80), rows: 10, anchor: LATEST });
    expect(before.atLatest).toBe(true);
    expect(after.atLatest).toBe(true);
    expect(after.unseenBlocks).toBe(0);
  });
});

describe("a reader who scrolled away", () => {
  const history = spans(100);
  const pinned = anchorAt({ spans: history, rows: 10, anchor: LATEST }, 40);

  test("is pinned to a block rather than to a row number", () => {
    expect(pinned).toEqual({ kind: "pinned", key: "b20", rowOffset: 0 });
  });

  test("is not moved when new blocks arrive", () => {
    // The promise. Arriving activity changes what is below, never what is on
    // screen.
    const before = windowFor({ spans: history, rows: 10, anchor: pinned });
    const after = windowFor({ spans: spans(400), rows: 10, anchor: pinned });
    expect(after.firstIndex).toBe(before.firstIndex);
    expect(after.skippedRows).toBe(before.skippedRows);
    expect(topRowOf({ spans: spans(400), rows: 10, anchor: pinned })).toBe(40);
  });

  test("is told how much arrived below", () => {
    const view = windowFor({ spans: spans(400), rows: 10, anchor: pinned });
    expect(view.atLatest).toBe(false);
    expect(view.unseenBlocks).toBeGreaterThan(0);
  });

  test("follows again after jumping to the latest", () => {
    const view = windowFor({ spans: spans(400), rows: 10, anchor: LATEST });
    expect(view.atLatest).toBe(true);
    expect(view.unseenBlocks).toBe(0);
  });
});

describe("a resize", () => {
  test("keeps the reader on the same block when its height changes", () => {
    // The re-wrap case. The pinned block goes from two rows to six because the
    // terminal narrowed, and the reader is still reading that block.
    const before: readonly BlockSpan[] = spans(100);
    const after = before.map((span) => (span.key === "b20" ? { ...span, rows: 6 } : span));
    const anchor = { kind: "pinned", key: "b20", rowOffset: 0 } as const;

    const wide = windowFor({ spans: before, rows: 10, anchor });
    const narrow = windowFor({ spans: after, rows: 10, anchor });
    expect(before[20]?.key).toBe("b20");
    expect(wide.firstIndex).toBe(narrow.firstIndex);
  });

  test("keeps the anchor identity when every block re-wraps", () => {
    const tall = spans(100, 5);
    const anchor = { kind: "pinned", key: "b40", rowOffset: 1 } as const;
    const view = windowFor({ spans: tall, rows: 10, anchor });
    expect(topRowOf({ spans: tall, rows: 10, anchor })).toBe(40 * 5 + 1);
    expect(view.atLatest).toBe(false);
  });

  test("clamps a pin that a taller terminal moved past the end", () => {
    // A pin taken near the end of a short transcript, then a terminal tall
    // enough to show the whole thing. The window cannot start past the content.
    const short = spans(6);
    const anchor = { kind: "pinned", key: "b5", rowOffset: 0 } as const;
    expect(topRowOf({ spans: short, rows: 40, anchor })).toBe(0);
    expect(windowFor({ spans: short, rows: 40, anchor }).atLatest).toBe(true);
  });
});

describe("a pin to a block that is gone", () => {
  test("resolves to the latest rather than to nothing", () => {
    const anchor = { kind: "pinned", key: "missing", rowOffset: 3 } as const;
    const view = windowFor({ spans: spans(50), rows: 10, anchor });
    expect(view.atLatest).toBe(true);
    expect(view.visibleRows).toBe(10);
  });
});

describe("scrolling", () => {
  const history = spans(100);
  const request = { spans: history, rows: 10, anchor: LATEST } as const;

  test("upwards pins the block the new top row lands in", () => {
    const anchor = scrolledBy(request, -10);
    expect(anchor).toEqual({ kind: "pinned", key: "b90", rowOffset: 0 });
  });

  test("back down to the end returns to following", () => {
    // Not a pin on the last block: a reader who scrolled back to the bottom is
    // following again, which is what makes the unseen notice go away.
    const up = scrolledBy(request, -10);
    expect(scrolledBy({ ...request, anchor: up }, 10)).toEqual(LATEST);
  });

  test("past the start stops at the start", () => {
    const anchor = scrolledBy(request, -10_000);
    expect(topRowOf({ ...request, anchor })).toBe(0);
  });

  test("past the end stops at the latest", () => {
    expect(scrolledBy(request, 10_000)).toEqual(LATEST);
  });
});

describe("revealing a block", () => {
  const history = spans(100);

  test("leaves the window alone when the block is already visible", () => {
    // The rule that keeps selection from yanking a reader: a block on screen is
    // not scrolled to.
    const anchor = { kind: "pinned", key: "b50", rowOffset: 0 } as const;
    expect(anchorRevealing({ spans: history, rows: 10, anchor }, "b51")).toBe(anchor);
  });

  test("scrolls the shortest distance to bring one above into view", () => {
    const anchor = { kind: "pinned", key: "b50", rowOffset: 0 } as const;
    const revealed = anchorRevealing({ spans: history, rows: 10, anchor }, "b40");
    expect(revealed).toEqual({ kind: "pinned", key: "b40", rowOffset: 0 });
  });

  test("scrolls the shortest distance to bring one below into view", () => {
    const anchor = { kind: "pinned", key: "b50", rowOffset: 0 } as const;
    const revealed = anchorRevealing({ spans: history, rows: 10, anchor }, "b60");
    expect(topRowOf({ spans: history, rows: 10, anchor: revealed })).toBe(60 * 2 + 2 - 10);
  });

  test("does nothing for a block that is not there", () => {
    const anchor = { kind: "pinned", key: "b50", rowOffset: 0 } as const;
    expect(anchorRevealing({ spans: history, rows: 10, anchor }, "gone")).toBe(anchor);
  });
});

describe("degenerate geometry", () => {
  test("treats a region of no rows as showing nothing", () => {
    // A terminal genuinely reports zero during a resize.
    for (const rows of [0, -4, Number.NaN, 0.4]) {
      const view = windowFor({ spans: spans(10), rows, anchor: LATEST });
      expect({ rows, visible: view.visibleRows }).toEqual({ rows, visible: 0 });
    }
  });

  test("handles an empty transcript without inventing a window", () => {
    const view = windowFor({ spans: [], rows: 20, anchor: LATEST });
    expect(view.firstIndex).toBe(0);
    expect(view.lastIndex).toBe(0);
    expect(view.totalRows).toBe(0);
    expect(view.atLatest).toBe(true);
  });

  test("does not let a zero-row block extend the visible range", () => {
    const mixed: readonly BlockSpan[] = [
      { key: "a", rows: 2 },
      { key: "empty", rows: 0 },
      { key: "b", rows: 2 },
    ];
    const view = windowFor({ spans: mixed, rows: 10, anchor: LATEST, overscan: 0 });
    expect(view.firstIndex).toBe(0);
    expect(view.lastIndex).toBe(3);
    expect(totalRowsOf(mixed)).toBe(4);
  });
});

describe("row arithmetic", () => {
  test("sums heights and locates a block's first row", () => {
    expect(totalRowsOf(spans(4, 3))).toBe(12);
    expect(startRowOf(spans(4, 3), 0)).toBe(0);
    expect(startRowOf(spans(4, 3), 2)).toBe(6);
    expect(startRowOf(spans(4, 3), 99)).toBe(12);
  });

  test("ignores a negative height rather than subtracting it", () => {
    const broken: readonly BlockSpan[] = [
      { key: "a", rows: -5 },
      { key: "b", rows: 2 },
    ];
    expect(totalRowsOf(broken)).toBe(2);
  });
});
