/**
 * The headless-emulator oracle, without a compiled process.
 *
 * The compiled walk is where this module earns its keep. These checks prove the
 * adapter itself: it turns a transcript into rows at a known size, reports a
 * known overlap as overlapping, and never claims a clean transcript is mixed.
 */

import { describe, expect, test } from "bun:test";

import { emulateScreen, rowsCarryingMarksFromMultipleGroups } from "./emulated-screen-fixtures.ts";

const SIZE = { columns: 40, rows: 8 } as const;

/** Exclusive landmarks for two regions that must never share a row. */
const REGIONS = [["Activity"], ["Nothing is running"]] as const;

describe("emulateScreen", () => {
  test("turns a transcript slice into rows at the size it was given", async () => {
    const screen = await emulateScreen("\u001b[2J\u001b[HHello\u001b[2;1HWorld", SIZE);
    expect(screen.columns).toBe(SIZE.columns);
    expect(screen.terminalRows).toBe(SIZE.rows);
    expect(screen.rows).toHaveLength(SIZE.rows);
    expect(screen.rows[0]).toBe("Hello");
    expect(screen.rows[1]).toBe("World");
    expect(screen.cursor).toEqual({ column: 5, row: 1 });
  });

  test("reports a known overlap as overlapping", async () => {
    // Both exclusive marks on one row. Built as a transcript rather than
    // captured from a defect, so the check fails for the right reason even when
    // the shipped frame is clean. The real #385 splice can erase whole words;
    // the oracle's job here is to name a row that still carries both marks.
    const overlapped = "\u001b[2J\u001b[HActivity · 2 running\u001b[1;20HNothing is running.";
    const screen = await emulateScreen(overlapped, SIZE);
    const mixed = rowsCarryingMarksFromMultipleGroups(screen.rows, REGIONS);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed[0]).toContain("Activity");
    expect(mixed[0]).toContain("Nothing is running");
  });

  test("reports a clean layout as clean", async () => {
    const clean = "\u001b[2J\u001b[HActivity · 2 running\u001b[2;1HNothing is running.";
    const screen = await emulateScreen(clean, SIZE);
    expect(rowsCarryingMarksFromMultipleGroups(screen.rows, REGIONS)).toEqual([]);
  });
});
