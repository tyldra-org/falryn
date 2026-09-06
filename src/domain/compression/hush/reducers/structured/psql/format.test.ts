import { describe, expect, test } from "bun:test";

import { formatPsqlAlignedTable, formatPsqlExpandedTable, formatPsqlResult } from "./format.ts";

const TABLE = [
  " id | task                   | status  | token_savings",
  "----+------------------------+---------+--------------",
  "  1 | Optimize nested JSON   | done    |            32",
  "  2 | Preserve database rows | active  |             0",
  "  3 | Verify model context   | pending |            18",
  "(3 rows)",
  "",
].join("\n");

const EXPANDED = [
  "-[ RECORD 1 ]----------------",
  "id     | 101",
  "task   | Investigate latency",
  "status | active",
  "-[ RECORD 2 ]----------------",
  "id     | 102",
  "task   | Verify recovery",
  "status | done",
  "(2 rows)",
  "",
].join("\n");

describe("psql result format", () => {
  test("removes only validated alignment presentation", () => {
    expect(formatPsqlAlignedTable(TABLE)).toBe(
      [
        "id\ttask\tstatus\ttoken_savings",
        "1\tOptimize nested JSON\tdone\t32",
        "2\tPreserve database rows\tactive\t0",
        "3\tVerify model context\tpending\t18",
        "",
      ].join("\n"),
    );
  });

  test("keeps zero, one, and empty cells unambiguous", () => {
    expect(formatPsqlAlignedTable(" id | note\n----+------\n(0 rows)\n")).toBe("id\tnote\n");
    expect(formatPsqlAlignedTable(" id | note\n----+------\n  1 |     \n(1 row)\n")).toBe(
      "id\tnote\n1\t\n",
    );
  });

  test("retains every result row without an item-count cap", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ` ${index + 1} | item-${index + 1}`);
    const source = [" id | item", "----+--------", ...rows, "(80 rows)", ""].join("\n");
    const formatted = formatPsqlAlignedTable(source);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("1\titem-1");
    expect(formatted).toContain("80\titem-80");
    expect(formatted?.split("\n")).toHaveLength(82);
  });

  test("refuses mismatched counts, malformed separators, and ambiguous rows", () => {
    expect(formatPsqlAlignedTable(TABLE.replace("(3 rows)", "(2 rows)"))).toBeNull();
    expect(formatPsqlAlignedTable(TABLE.replace("----+", "====+"))).toBeNull();
    expect(
      formatPsqlAlignedTable(TABLE.replace("Optimize nested JSON", "left | right")),
    ).toBeNull();
    expect(formatPsqlAlignedTable(`${TABLE}SELECT 3\n`)).toBeNull();
  });

  test("turns complete expanded records into one schema-labelled table", () => {
    expect(formatPsqlExpandedTable(EXPANDED)).toBe(
      [
        "record\tid\ttask\tstatus",
        "1\t101\tInvestigate latency\tactive",
        "2\t102\tVerify recovery\tdone",
        "",
      ].join("\n"),
    );
    expect(formatPsqlResult(EXPANDED)).toBe(formatPsqlExpandedTable(EXPANDED));
    expect(formatPsqlExpandedTable("-[ RECORD 1 ]----\nnote |   padded  \n(1 row)\n")).toBe(
      "record\tnote\n1\t  padded  \n",
    );
  });

  test("retains every expanded record without an item-count cap", () => {
    const records = Array.from({ length: 80 }, (_, index) => [
      `-[ RECORD ${index + 1} ]----`,
      `id   | ${index + 1}`,
      `name | item-${index + 1}`,
    ]).flat();
    const formatted = formatPsqlExpandedTable([...records, "(80 rows)", ""].join("\n"));

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("1\t1\titem-1");
    expect(formatted).toContain("80\t80\titem-80");
    expect(formatted?.split("\n")).toHaveLength(82);
  });

  test("refuses incomplete or ambiguous expanded records", () => {
    expect(formatPsqlExpandedTable(EXPANDED.replace("(2 rows)", "(3 rows)"))).toBeNull();
    expect(formatPsqlExpandedTable(EXPANDED.replace("status | done", "state  | done"))).toBeNull();
    expect(
      formatPsqlExpandedTable(EXPANDED.replace("task   | Verify", "       | Verify")),
    ).toBeNull();
    expect(formatPsqlExpandedTable(EXPANDED.replace("latency", "left | right"))).toBeNull();
  });
});
