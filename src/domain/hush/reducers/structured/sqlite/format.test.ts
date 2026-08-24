import { describe, expect, test } from "bun:test";

import {
  formatSqliteBorderedTable,
  formatSqliteColumnTable,
  formatSqliteLineRecords,
  formatSqliteMarkdownTable,
  formatSqliteResult,
} from "./format.ts";

const COLUMN = [
  "id  task           status",
  "--  -------------  ------",
  "1   Optimize JSON  done  ",
  "2   Preserve rows  active",
  "",
].join("\n");

const TABLE = [
  "+----+---------------+--------+",
  "| id |     task      | status |",
  "+----+---------------+--------+",
  "| 1  | Optimize JSON | done   |",
  "| 2  | Preserve rows | active |",
  "+----+---------------+--------+",
  "",
].join("\n");

const BOX = [
  "┌────┬───────────────┬────────┐",
  "│ id │     task      │ status │",
  "├────┼───────────────┼────────┤",
  "│ 1  │ Optimize JSON │ done   │",
  "│ 2  │ Preserve rows │ active │",
  "└────┴───────────────┴────────┘",
  "",
].join("\n");

const MARKDOWN = [
  "| id |     task      | status |",
  "|----|---------------|--------|",
  "| 1  | Optimize JSON | done   |",
  "| 2  | Preserve rows | active |",
  "",
].join("\n");

const LINE = [
  "    id = 1",
  "  task = Optimize JSON",
  "status = done",
  "",
  "    id = 2",
  "  task = Preserve rows",
  "status = active",
  "",
].join("\n");

const EXPECTED_TABLE = [
  "id\ttask\tstatus",
  "1\tOptimize JSON\tdone",
  "2\tPreserve rows\tactive",
  "",
].join("\n");

describe("sqlite3 result format", () => {
  test("removes only validated column alignment", () => {
    expect(formatSqliteColumnTable(COLUMN)).toBe(EXPECTED_TABLE);
    expect(formatSqliteColumnTable("id\n--\n1\n")).toBe("id\n1\n");
    expect(formatSqliteResult(COLUMN)).toBe(EXPECTED_TABLE);
  });

  test("normalizes ASCII and Unicode borders to the same readable table", () => {
    expect(formatSqliteBorderedTable(TABLE)).toBe(EXPECTED_TABLE);
    expect(formatSqliteBorderedTable(BOX)).toBe(EXPECTED_TABLE);
  });

  test("removes only a validated Markdown separator", () => {
    expect(formatSqliteMarkdownTable(MARKDOWN)).toBe(EXPECTED_TABLE);
  });

  test("shares line-mode keys once while preserving value whitespace", () => {
    expect(formatSqliteLineRecords(LINE)).toBe(
      [
        "record\tid\ttask\tstatus",
        "1\t1\tOptimize JSON\tdone",
        "2\t2\tPreserve rows\tactive",
        "",
      ].join("\n"),
    );
    expect(formatSqliteLineRecords("  id = 1\nnote =   padded  \n")).toBe(
      "record\tid\tnote\n1\t1\t  padded  \n",
    );
  });

  test("retains every column row and line record without an item-count cap", () => {
    const columnRows = Array.from(
      { length: 80 },
      (_, index) => `${String(index + 1).padEnd(2)}  ${`item-${index + 1}`.padEnd(7)}`,
    );
    const column = formatSqliteColumnTable(
      ["id  item   ", "--  -------", ...columnRows, ""].join("\n"),
    );
    const lineRows = Array.from({ length: 80 }, (_, index) => [
      `  id = ${index + 1}`,
      `name = item-${index + 1}`,
      ...(index === 79 ? [] : [""]),
    ]).flat();
    const line = formatSqliteLineRecords([...lineRows, ""].join("\n"));

    expect(column).toContain("1\titem-1");
    expect(column).toContain("80\titem-80");
    expect(column?.split("\n")).toHaveLength(82);
    expect(line).toContain("1\t1\titem-1");
    expect(line).toContain("80\t80\titem-80");
    expect(line?.split("\n")).toHaveLength(82);
  });

  test("refuses inconsistent, wrapped, or delimiter-ambiguous shapes", () => {
    expect(formatSqliteColumnTable(COLUMN.replace("Preserve rows", "Preserve   rows"))).toBeNull();
    expect(formatSqliteColumnTable("name\n----\n測試\n")).toBeNull();
    expect(formatSqliteColumnTable("id\n--\n1\nid\n--\n2\n")).toBeNull();
    expect(formatSqliteBorderedTable(TABLE.replace("+--------+", "+-------+"))).toBeNull();
    expect(formatSqliteBorderedTable(BOX.replace("Optimize JSON", "left │ right"))).toBeNull();
    expect(formatSqliteMarkdownTable(MARKDOWN.replace("Preserve rows", "left | right"))).toBeNull();
    expect(
      formatSqliteMarkdownTable("| id |\n|----|\n| 1  |\n| id |\n|----|\n| 2  |\n"),
    ).toBeNull();
    expect(formatSqliteLineRecords(LINE.replace("status = active", "state = active"))).toBeNull();
    expect(formatSqliteLineRecords(LINE.replace("Optimize JSON", "left = right"))).toBeNull();
    expect(formatSqliteLineRecords(LINE.replace("\n\n", "\n\n\n"))).toBeNull();
  });
});
