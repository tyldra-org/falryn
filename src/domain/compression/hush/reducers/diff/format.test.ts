import { describe, expect, test } from "bun:test";

import { formatExternalUnifiedDiff } from "./format.ts";

describe("external unified diff format", () => {
  test("keeps file identity, ranges, and every changed line while removing presentation context", () => {
    const source = [
      "--- src/add.ts\t2026-08-23 06:16:58",
      "+++ src/commit.ts\t2026-08-23 06:16:58",
      "@@ -1,5 +1,6 @@",
      " export function project() {",
      '-  const mode = "sample";',
      '+  const mode = "complete";',
      "   const marker = 736;",
      "+  const exact = true;",
      "-  return mode;",
      '+  return exact ? mode : "sample";',
      " }",
    ].join("\n");

    expect(formatExternalUnifiedDiff(source)).toBe(
      [
        "src/add.ts -> src/commit.ts",
        "@@ -1,5 +1,6 @@",
        '-  const mode = "sample";',
        '+  const mode = "complete";',
        "+  const exact = true;",
        "-  return mode;",
        '+  return exact ? mode : "sample";',
      ].join("\n"),
    );
  });

  test("keeps no-newline markers and paths containing spaces", () => {
    const source = [
      "--- before file.ts",
      "+++ after file.ts",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    expect(formatExternalUnifiedDiff(source)).toBe(
      [
        "before file.ts -> after file.ts",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ].join("\n"),
    );
  });

  test("retains every changed line without a result-count cap", () => {
    const removed = Array.from({ length: 80 }, (_, index) => `-before-${index + 1}`);
    const added = Array.from({ length: 80 }, (_, index) => `+after-${index + 1}`);
    const source = [
      "--- before.ts",
      "+++ after.ts",
      "@@ -1,80 +1,80 @@",
      ...removed,
      ...added,
    ].join("\n");
    const formatted = formatExternalUnifiedDiff(source);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("-before-80");
    expect(formatted).toContain("+after-80");
    expect(formatted?.split("\n")).toHaveLength(162);
  });

  test("refuses malformed or incomplete hunks instead of guessing", () => {
    expect(
      formatExternalUnifiedDiff(
        ["--- before.ts", "+++ after.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n"),
      ),
    ).toBeNull();
    expect(formatExternalUnifiedDiff("not a unified diff")).toBeNull();
  });
});
