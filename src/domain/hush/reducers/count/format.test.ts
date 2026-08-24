import { describe, expect, test } from "bun:test";

import { formatWcOutput } from "./format.ts";

describe("wc format", () => {
  test("removes single-file padding and a path already present in the command", () => {
    expect(
      formatWcOutput("     127     384    3268 src/domain/hush/reducers/log/format.ts\n", [
        "wc",
        "-l",
        "-w",
        "-c",
        "src/domain/hush/reducers/log/format.ts",
      ]),
    ).toBe("127 384 3268\n");
  });

  test("labels the default columns without exceeding the RTK representation", () => {
    expect(
      formatWcOutput("     127     384    3268 src/format.ts\n", ["wc", "src/format.ts"]),
    ).toBe("127L 384W 3268B\n");
  });

  test("keeps multi-file rows identifiable and compacts the total", () => {
    expect(
      formatWcOutput(
        [
          "     127     384    3268 src/domain/hush/reducers/log/format.ts",
          "      32     131    1251 src/domain/hush/reducers/log/projection.ts",
          "     159     515    4519 total",
          "",
        ].join("\n"),
        [
          "wc",
          "src/domain/hush/reducers/log/format.ts",
          "src/domain/hush/reducers/log/projection.ts",
        ],
      ),
    ).toBe(
      ["127L 384W 3268B format.ts", "32L 131W 1251B projection.ts", "Σ 159L 515W 4519B", ""].join(
        "\n",
      ),
    );
  });

  test("supports clustered, long, stdin, and end-of-options forms", () => {
    expect(formatWcOutput("  7  11  42 src/a.ts\n", ["wc", "-lwc", "src/a.ts"])).toBe("7 11 42\n");
    expect(formatWcOutput("  7  11 src/a.ts\n", ["wc", "--lines", "--words", "src/a.ts"])).toBe(
      "7 11\n",
    );
    expect(formatWcOutput("  7  11  42\n", ["wc"])).toBe("7L 11W 42B\n");
    expect(formatWcOutput("  7 --counts.ts\n", ["wc", "-l", "--", "--counts.ts"])).toBe("7\n");
  });

  test("retains every multi-file row without a result-count cap", () => {
    const operands = Array.from({ length: 80 }, (_, index) => `src/file-${index + 1}.ts`);
    const source = `${[
      ...operands.map((operand, index) => `  ${index + 1} ${operand}`),
      "  3240 total",
    ].join("\n")}\n`;
    const formatted = formatWcOutput(source, ["wc", "-l", ...operands]);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("1 file-1.ts");
    expect(formatted).toContain("80 file-80.ts");
    expect(formatted).toContain("Σ 3240");
    expect(formatted?.split("\n")).toHaveLength(82);
  });

  test("refuses malformed, mismatched, and indirection-driven output", () => {
    expect(formatWcOutput("not a count row\n", ["wc", "src/a.ts"])).toBeNull();
    expect(formatWcOutput("  7 src/b.ts\n", ["wc", "-l", "src/a.ts"])).toBeNull();
    expect(formatWcOutput("  7 src/a.ts\n", ["wc", "--files0-from", "paths.txt"])).toBeNull();
  });
});
