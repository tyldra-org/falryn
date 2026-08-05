/**
 * The mapping between a draft position and a screen cell, both ways.
 *
 * The checks that matter are the ones where a cell index and a grapheme index
 * are different numbers, because everywhere else the two directions agree by
 * accident. A CJK run is two cells per grapheme, a combining sequence is one
 * cell for several code points, and a joined emoji is one grapheme the domain
 * measures wider than it draws — that last one is a recorded disagreement
 * between the arithmetic and the renderer, and this module is deliberately on
 * the arithmetic's side of it: what matters here is that both directions use
 * the same measurement, not that the measurement is right.
 *
 * The round trip is the load-bearing check. Two functions computing one
 * relationship stay correct only if something asserts they agree, and asserting
 * it for *every* column of a line is the difference between a property and a
 * spot check.
 */

import { describe, expect, test } from "bun:test";
import { graphemes } from "../../domain/index.ts";
import {
  cellOfColumn,
  cellOfPosition,
  columnOfCell,
  type DrawnLine,
  positionOfCell,
} from "./geometry.ts";

/** Lines whose cells and columns disagree, each for a different reason. */
const PLAIN = "hello world";
/** Two graphemes, four cells. */
const WIDE = "日本語です";
/** `e` plus a combining acute: one grapheme, one cell, two code points. */
const COMBINING = "café latte";
/** A family sequence: one grapheme, several code points, joined. */
const EMOJI = "hi 👨‍👩‍👧‍👦 there";

const LINES: readonly DrawnLine[] = [
  { number: 0, text: PLAIN },
  { number: 1, text: WIDE },
  { number: 2, text: "" },
];

const REGION = { lines: LINES, originColumn: 4, originRow: 10 } as const;

describe("a column and a cell", () => {
  test("agree on text where every grapheme is one cell", () => {
    expect(cellOfColumn(PLAIN, 0)).toBe(0);
    expect(cellOfColumn(PLAIN, 5)).toBe(5);
    expect(columnOfCell(PLAIN, 5)).toBe(5);
  });

  test("differ by a cell for every wide grapheme before the position", () => {
    // The defect this module exists to prevent, stated as a number: two
    // graphemes of `日本` are four cells, so a mapping that counted graphemes
    // would place a click two cells left of where it landed.
    expect(cellOfColumn(WIDE, 2)).toBe(4);
    expect(columnOfCell(WIDE, 4)).toBe(2);
  });

  test("treat a combining sequence as the one character it draws as", () => {
    const units = graphemes(COMBINING);
    // `café` is four graphemes and four cells despite being five code points.
    expect(units[3]).toBe("é");
    expect(cellOfColumn(COMBINING, 4)).toBe(4);
    expect(columnOfCell(COMBINING, 4)).toBe(4);
  });

  test("treat a joined emoji as one position", () => {
    // One grapheme, whatever its width is measured to be. The check is that
    // both directions land on the same boundary, not on a particular width —
    // `displayWidth` and the renderer are recorded as disagreeing about joined
    // emoji, and this module inherits that rather than inventing a third answer.
    const before = cellOfColumn(EMOJI, 3);
    const after = cellOfColumn(EMOJI, 4);
    expect(after).toBeGreaterThan(before);
    expect(columnOfCell(EMOJI, before)).toBe(3);
    expect(columnOfCell(EMOJI, after)).toBe(4);
  });
});

describe("the round trip", () => {
  // The property, over every column of every awkward line. A spot check would
  // pass against a mapping that is right in the middle and wrong at the edges,
  // which is exactly the shape this arithmetic fails in.
  for (const [name, text] of [
    ["plain", PLAIN],
    ["wide", WIDE],
    ["combining", COMBINING],
    ["emoji", EMOJI],
  ] as const) {
    test(`returns the column it started from, for every column of ${name} text`, () => {
      const units = graphemes(text);
      for (let column = 0; column <= units.length; column += 1) {
        expect({ column, back: columnOfCell(text, cellOfColumn(text, column)) }).toEqual({
          column,
          back: column,
        });
      }
    });
  }
});

describe("a cell inside a wide grapheme", () => {
  test("resolves to the grapheme's start, both halves alike", () => {
    // The stated choice. A position between the two cells of `日` does not
    // exist in the draft, so inventing one would let a click produce a column
    // the editing model can never hold.
    expect(columnOfCell(WIDE, 0)).toBe(0);
    expect(columnOfCell(WIDE, 1)).toBe(0);
    expect(columnOfCell(WIDE, 2)).toBe(1);
    expect(columnOfCell(WIDE, 3)).toBe(1);
  });
});

describe("a cell outside the text", () => {
  test("before the start resolves to the start", () => {
    expect(columnOfCell(PLAIN, -7)).toBe(0);
  });

  test("just past the last grapheme resolves to the end", () => {
    expect(columnOfCell(PLAIN, graphemes(PLAIN).length)).toBe(graphemes(PLAIN).length);
  });

  test("far past a short line resolves to that line's end", () => {
    expect(columnOfCell(WIDE, 400)).toBe(graphemes(WIDE).length);
  });

  test("on an empty line resolves to its only position", () => {
    expect(columnOfCell("", 12)).toBe(0);
  });
});

describe("a screen cell in the drawn region", () => {
  test("resolves to the line and column it is over", () => {
    // The region's own offset is subtracted, so the caller hands over the
    // coordinates the renderer reports rather than ones it computed itself.
    expect(positionOfCell(REGION, { column: 4 + 5, row: 10 })).toEqual({ line: 0, column: 5 });
    expect(positionOfCell(REGION, { column: 4 + 4, row: 11 })).toEqual({ line: 1, column: 2 });
  });

  test("resolves a row above the window to the first drawn line", () => {
    // A drag that leaves the top of the composer means the first line. Nothing,
    // returned here, would make every caller write that rule again.
    expect(positionOfCell(REGION, { column: 4, row: 3 })).toEqual({ line: 0, column: 0 });
  });

  test("resolves a row below the window to the last drawn line", () => {
    expect(positionOfCell(REGION, { column: 4, row: 99 })).toEqual({ line: 2, column: 0 });
  });

  test("resolves a column left of the region to the start of the line", () => {
    expect(positionOfCell(REGION, { column: 0, row: 10 })).toEqual({ line: 0, column: 0 });
  });

  test("names the draft's line number, not the window's offset", () => {
    // The window is anchored to the cursor, so the first drawn line is rarely
    // line zero. A mapping that returned the offset would edit the wrong line
    // of any draft long enough to scroll.
    const scrolled = {
      lines: [
        { number: 40, text: PLAIN },
        { number: 41, text: WIDE },
      ],
      originColumn: 0,
      originRow: 0,
    };
    expect(positionOfCell(scrolled, { column: 2, row: 1 })).toEqual({ line: 41, column: 1 });
  });

  test("has no answer when nothing is drawn", () => {
    // Reported rather than answered as line zero: a composer that has drawn
    // nothing has no position to name.
    expect(
      positionOfCell({ lines: [], originColumn: 0, originRow: 0 }, { column: 0, row: 0 }),
    ).toBe(null);
  });
});

describe("a draft position's cell", () => {
  test("is measured on the line it belongs to", () => {
    expect(cellOfPosition(LINES, { line: 1, column: 2 })).toBe(4);
  });

  test("has no answer for a line the window does not draw", () => {
    expect(cellOfPosition(LINES, { line: 40, column: 0 })).toBe(null);
  });
});
