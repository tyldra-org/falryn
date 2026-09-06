import { describe, expect, test } from "bun:test";

import { formatSearchMatches } from "./format.ts";

describe("Hush search formatting", () => {
  test("retains every ripgrep match without a fixed result or line-length cap", () => {
    const output = Array.from(
      { length: 100 },
      (_, index) =>
        `src/very/repeated/path/file.ts:${index + 1}:${"complete match context ".repeat(6)}tail-${index}`,
    ).join("\n");
    const formatted = formatSearchMatches(output);
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("src/very/repeated/path/file.ts:");
    expect(formatted).toContain("  1 complete match context");
    expect(formatted).toContain("tail-99");
    expect(formatted?.match(/tail-\d+/gu)).toHaveLength(100);
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("compacts search blocks inside mixed compound output and preserves other lines", () => {
    const formatted = formatSearchMatches(
      [
        "src/a.ts:10:first marker",
        "src/a.ts:20:second marker",
        "# exact sed output",
        "src/b.ts:7:third marker",
        "src/b.ts:8:fourth marker",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "src/a.ts:",
        "  10 first marker",
        "  20 second marker",
        "# exact sed output",
        "src/b.ts:",
        "  7 third marker",
        "  8 fourth marker",
      ].join("\n"),
    );
  });

  test("declines shapes where Hush cannot reduce syntax safely", () => {
    expect(formatSearchMatches("src/a.ts\nsrc/b.ts\n")).toBeNull();
    expect(formatSearchMatches('{"type":"match","data":{}}\n')).toBeNull();
  });
});
