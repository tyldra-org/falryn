/**
 * How a panel of a given height is spent.
 *
 * The arithmetic on its own, without a renderer. What the panel actually draws
 * is measured in `./frame.test.tsx`, at every step of the reveal — this file
 * pins the rule those frames are the consequence of, so a wrong split is
 * readable as a wrong number rather than only as a smeared row.
 */

import { describe, expect, test } from "bun:test";
import { HINT_ROWS, OPENING_ROWS, overlayRows, PANEL_BORDER_ROWS } from "./overlay.tsx";

describe("the overlay's row budget", () => {
  test("never promises the route a row the panel does not have", async () => {
    // #366 as a property rather than an example. Whatever the split, the panel's
    // own border plus the hint plus the content must fit inside the height it was
    // given — the previous `Math.max(1, height - 3)` broke this at 3 and below.
    for (let height = 0; height <= 40; height += 1) {
      const rows = overlayRows(height);
      const drawn = PANEL_BORDER_ROWS + rows.content + (rows.hint ? HINT_ROWS : 0);
      expect({ height, fits: drawn <= Math.max(height, PANEL_BORDER_ROWS) }).toEqual({
        height,
        fits: true,
      });
    }
  });

  test("spends the reveal's own height on the way out, not on content", async () => {
    // The step every overlay open passes through. One interior row, and it goes
    // to the hint: content the panel cannot fit is unreadable either way, while a
    // dismissal hint that loses its row is a user who cannot see how to close
    // what just opened.
    expect(overlayRows(OPENING_ROWS)).toEqual({ content: 0, hint: true });
  });

  test("gives a panel with no interior nothing at all", async () => {
    expect(overlayRows(PANEL_BORDER_ROWS)).toEqual({ content: 0, hint: false });
    expect(overlayRows(0)).toEqual({ content: 0, hint: false });
  });

  test("gives the rest to the route once the hint is paid", async () => {
    // The resting case, unchanged by #366: a twelve-row panel still hands ten
    // rows on. The fix is at the small end, and a fix that quietly cost a row
    // everywhere would be a different regression.
    expect(overlayRows(12)).toEqual({ content: 9, hint: true });
    expect(overlayRows(4)).toEqual({ content: 1, hint: true });
  });

  test("is monotonic, so a taller panel never shows less", async () => {
    // A split with a special case in it can go backwards. This is the cheapest
    // check that it does not.
    let previous = -1;
    for (let height = 0; height <= 40; height += 1) {
      const { content } = overlayRows(height);
      expect({ height, grew: content >= previous }).toEqual({ height, grew: true });
      previous = content;
    }
  });
});
