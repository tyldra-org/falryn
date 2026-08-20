/**
 * Collapsing wrapped content rows into one selectable body (#622).
 */

import { describe, expect, test } from "bun:test";
import { contentLineCount, entriesForVisibleRows } from "./render-rows.ts";
import type { TranscriptRow } from "./rows.ts";

function contentRow(key: string, line: number, text: string): TranscriptRow {
  return {
    kind: "text",
    key: `${key}:content:0:${line}`,
    text,
    color: "foreground",
    typography: "body",
    untrusted: true,
    indent: 4,
  };
}

describe("entriesForVisibleRows", () => {
  test("collapses a fully visible single-body block into one textarea entry", () => {
    const blockKey = "msg-1";
    const rows = [contentRow(blockKey, 0, "alpha beta"), contentRow(blockKey, 1, "gamma")];
    const entries = entriesForVisibleRows(
      rows,
      { key: blockKey, text: "alpha beta\ngamma", contentLines: 2 },
      true,
    );
    expect(entries).toEqual([
      {
        kind: "body",
        key: `${blockKey}:content:0:0`,
        text: "alpha beta\ngamma",
        height: 2,
        focused: true,
      },
    ]);
  });

  test("keeps line rows when the body is only partially visible", () => {
    const blockKey = "msg-2";
    const rows = [contentRow(blockKey, 1, "second line")];
    const entries = entriesForVisibleRows(
      rows,
      { key: blockKey, text: "first\nsecond line", contentLines: 2 },
      true,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected a content row");
    }
    expect(entries).toEqual([{ kind: "row", row }]);
  });

  test("counts wrapped content lines for a block", () => {
    const blockKey = "msg-3";
    const rows = [contentRow(blockKey, 0, "a"), contentRow(blockKey, 1, "b")];
    expect(contentLineCount(rows, blockKey)).toBe(2);
  });
});
