/**
 * Layout class selection.
 *
 * A pure function of two numbers, tested at every boundary and at every
 * degenerate value — which is the point of having written it as one. The class
 * governs every arrangement decision in the interface, so an off-by-one here is
 * a terminal size at which the whole frame is laid out for a window that is not
 * the one the user has.
 */

import { describe, expect, test } from "bun:test";
import {
  hasContextPanel,
  isSingleRegion,
  LAYOUT_CLASSES,
  PANEL_COLUMNS,
  primaryColumns,
  STANDARD_COLUMNS,
  STANDARD_ROWS,
  selectLayout,
  shareRow,
  WIDE_COLUMNS,
  WIDE_ROWS,
} from "./layout.ts";
import { MINIMUM_COLUMNS, MINIMUM_ROWS } from "./theme/index.ts";

function classOf(columns: number, rows: number): string {
  const decision = selectLayout({ columns, rows });
  return decision.kind === "layout" ? decision.class : "insufficient";
}

describe("the classes", () => {
  test("are ordered by the room they need", () => {
    // The order the breakpoints assume. A `wide` threshold below `standard`
    // would make one of them unreachable and nothing else would notice.
    expect(MINIMUM_COLUMNS).toBeLessThan(STANDARD_COLUMNS);
    expect(STANDARD_COLUMNS).toBeLessThan(WIDE_COLUMNS);
    expect(MINIMUM_ROWS).toBeLessThan(STANDARD_ROWS);
    expect(STANDARD_ROWS).toBeLessThan(WIDE_ROWS);
  });

  test("derive the wide breakpoint rather than restating it", () => {
    // Moving the first breakpoint moves this one with it, instead of the two
    // silently overlapping.
    expect(WIDE_COLUMNS).toBe(STANDARD_COLUMNS + PANEL_COLUMNS);
  });
});

describe("selection", () => {
  test("names each class at its own boundary and one cell below", () => {
    // Both sides of every threshold, because an off-by-one is the failure this
    // function can actually have and it is invisible at any other size.
    expect(classOf(WIDE_COLUMNS, WIDE_ROWS)).toBe("wide");
    expect(classOf(WIDE_COLUMNS - 1, WIDE_ROWS)).toBe("standard");
    expect(classOf(WIDE_COLUMNS, WIDE_ROWS - 1)).toBe("standard");

    expect(classOf(STANDARD_COLUMNS, STANDARD_ROWS)).toBe("standard");
    expect(classOf(STANDARD_COLUMNS - 1, STANDARD_ROWS)).toBe("compact");
    expect(classOf(STANDARD_COLUMNS, STANDARD_ROWS - 1)).toBe("compact");

    expect(classOf(MINIMUM_COLUMNS, MINIMUM_ROWS)).toBe("compact");
    expect(classOf(MINIMUM_COLUMNS - 1, MINIMUM_ROWS)).toBe("insufficient");
    expect(classOf(MINIMUM_COLUMNS, MINIMUM_ROWS - 1)).toBe("insufficient");
  });

  test("falls one class rather than to compact when only the height is short", () => {
    // A 200×18 terminal is a good `standard` terminal. Calling it `compact`
    // would throw away room it plainly has.
    expect(classOf(300, STANDARD_ROWS)).toBe("standard");
    expect(classOf(300, WIDE_ROWS)).toBe("wide");
  });

  test("reports what an insufficient terminal needs, not only that it is small", () => {
    // "too small" is not something a user can act on; a pair of numbers is.
    expect(selectLayout({ columns: 10, rows: 3 })).toEqual({
      kind: "insufficient",
      needColumns: MINIMUM_COLUMNS,
      needRows: MINIMUM_ROWS,
    });
  });

  test("returns one of the declared classes, whatever the size", () => {
    // A sweep rather than a spot check: every class the function can return has
    // to be a class the interface knows how to render.
    for (let columns = 1; columns <= 200; columns += 7) {
      for (let rows = 1; rows <= 60; rows += 3) {
        const decision = selectLayout({ columns, rows });
        const named =
          decision.kind === "insufficient" ||
          (LAYOUT_CLASSES as readonly string[]).includes(decision.class);
        expect({ columns, rows, named }).toEqual({ columns, rows, named: true });
      }
    }
  });
});

describe("a viewport that does not exist", () => {
  test("is insufficient rather than a class chosen from nonsense", () => {
    // A terminal genuinely reports zero during a resize, and a `NaN` reaching a
    // comparison makes every one of them false — which would silently select
    // `compact` for a window with no size at all.
    for (const [columns, rows] of [
      [0, 0],
      [0, 40],
      [120, 0],
      [-5, 40],
      [Number.NaN, 40],
      [120, Number.NaN],
      [Number.POSITIVE_INFINITY, 40],
    ]) {
      expect({
        columns,
        rows,
        kind: selectLayout({ columns: columns ?? 0, rows: rows ?? 0 }).kind,
      }).toEqual({ columns, rows, kind: "insufficient" });
    }
  });

  test("truncates a fractional size rather than rejecting it", () => {
    // Half a cell is not a cell. Flooring is the honest reading, and it must not
    // round a terminal up over a threshold it did not reach.
    expect(classOf(STANDARD_COLUMNS + 0.9, STANDARD_ROWS)).toBe("standard");
    expect(classOf(STANDARD_COLUMNS - 0.1, STANDARD_ROWS)).toBe("compact");
  });
});

describe("what a class means", () => {
  test("compact is the only single-region class", () => {
    expect(isSingleRegion("compact")).toBe(true);
    expect(isSingleRegion("standard")).toBe(false);
    expect(isSingleRegion("wide")).toBe(false);
  });

  test("wide is the only class with room for a panel", () => {
    expect(hasContextPanel("wide")).toBe(true);
    expect(hasContextPanel("standard")).toBe(false);
    expect(hasContextPanel("compact")).toBe(false);
  });
});

describe("the primary region", () => {
  test("takes the whole width when there is no panel", () => {
    expect(primaryColumns({ columns: 100, rows: 30 }, "standard")).toBe(100);
    expect(primaryColumns({ columns: 40, rows: 12 }, "compact")).toBe(40);
  });

  test("gives the panel a fixed share rather than a proportion", () => {
    // Widening the terminal widens the transcript and leaves the panel at the
    // size it needs. Proportional splits are how interfaces become permanently
    // tiled control centres, which the design direction refuses.
    expect(primaryColumns({ columns: 200, rows: 40 }, "wide")).toBe(200 - PANEL_COLUMNS);
    expect(primaryColumns({ columns: 400, rows: 40 }, "wide")).toBe(400 - PANEL_COLUMNS);
  });

  test("never falls below what standard needs", () => {
    // The panel yields before the primary region does. A `wide` terminal that
    // squeezed the transcript below `standard` would be worse than a `standard`
    // one.
    expect(
      primaryColumns({ columns: WIDE_COLUMNS, rows: WIDE_ROWS }, "wide"),
    ).toBeGreaterThanOrEqual(STANDARD_COLUMNS);
  });
});

describe("sharing a row", () => {
  test("gives everything its natural width when they all fit", () => {
    expect(
      shareRow(
        [
          { natural: 10, weight: 2 },
          { natural: 5, weight: 1 },
        ],
        40,
      ),
    ).toEqual([10, 5]);
  });

  test("lets a field that fits keep what it needs while others compete", () => {
    // The everyday case, and the one an even split gets wrong: a long workspace
    // path beside a two-letter branch name. The short field takes its five cells
    // and the long one gets the rest, rather than each being cut to a quarter.
    const [long, short] = shareRow(
      [
        { natural: 100, weight: 2 },
        { natural: 5, weight: 1 },
      ],
      40,
    );
    expect(short).toBe(5);
    expect(long).toBeGreaterThan(30);
  });

  test("shares by weight only among the fields that do not fit", () => {
    const granted = shareRow(
      [
        { natural: 100, weight: 2 },
        { natural: 100, weight: 1 },
        { natural: 2, weight: 1 },
      ],
      40,
    );
    expect(granted[2]).toBe(2);
    // The two that did not fit split the remaining 38 in a 2:1 ratio.
    expect((granted[0] ?? 0) > (granted[1] ?? 0)).toBe(true);
  });

  test("never hands out more than the row has", () => {
    for (const room of [0, 1, 7, 40, 200]) {
      const granted = shareRow(
        [
          { natural: 50, weight: 2 },
          { natural: 50, weight: 1 },
          { natural: 50, weight: 1 },
        ],
        room,
        1,
      );
      const total = granted.reduce((sum, value) => sum + value, 0);
      // Except for the floor every field is guaranteed, which is what keeps a
      // one-column terminal from rendering four zero-width fields.
      expect({ room, within: total <= Math.max(room, granted.length) }).toEqual({
        room,
        within: true,
      });
    }
  });

  test("gives every field the floor rather than nothing", () => {
    const granted = shareRow(
      [
        { natural: 50, weight: 1 },
        { natural: 50, weight: 1 },
      ],
      0,
      3,
    );
    expect(granted).toEqual([3, 3]);
  });

  test("returns one width per field, always", () => {
    expect(shareRow([], 40)).toEqual([]);
    expect(shareRow([{ natural: 5, weight: 0 }], 40).length).toBe(1);
  });
});
