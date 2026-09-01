import { describe, expect, test } from "bun:test";

import { formatTypecheckDiagnostics } from "./format.ts";

describe("Hush typecheck diagnostic formats", () => {
  test("compacts TypeScript diagnostics without dropping locations, codes, or messages", () => {
    expect(
      formatTypecheckDiagnostics(
        [
          "src/a.ts(10,4): error TS2322: Type 'string' is not assignable to type 'number'.",
          "src/b.ts(20,8): error TS2304: Cannot find name 'missing'.",
          "Found 2 errors in 2 files.",
        ].join("\n"),
        ["tsc", "--noEmit"],
      ),
    ).toBe(
      [
        "2 errors in 2 files",
        "src/a.ts:10:4 error[TS2322]: Type 'string' is not assignable to type 'number'.",
        "src/b.ts:20:8 error[TS2304]: Cannot find name 'missing'.",
      ].join("\n"),
    );
  });

  test("removes Basedpyright discovery framing and redundant path headings", () => {
    expect(
      formatTypecheckDiagnostics(
        [
          "basedpyright 1.22.0",
          "Searching for source files",
          "Found 42 source files",
          "",
          "/workspace/app/main.py",
          '  /workspace/app/main.py:10:5 - error: "foo" is not defined (reportUndefinedVariable)',
          '  /workspace/app/main.py:25:1 - error: Type "str" is not assignable to type "int" (reportAssignmentType)',
          "",
          "/workspace/app/utils.py",
          '  /workspace/app/utils.py:8:9 - warning: Variable "x" is not accessed (reportUnusedVariable)',
          "",
          "2 errors, 1 warning, 0 informations",
        ].join("\n"),
        ["basedpyright"],
      ),
    ).toBe(
      [
        "2 errors, 1 warning, 0 informations",
        '/workspace/app/main.py:10:5 error[reportUndefinedVariable]: "foo" is not defined',
        '/workspace/app/main.py:25:1 error[reportAssignmentType]: Type "str" is not assignable to type "int"',
        '/workspace/app/utils.py:8:9 warning[reportUnusedVariable]: Variable "x" is not accessed',
      ].join("\n"),
    );
  });

  test("keeps ty source excerpts and highlighted spans while removing layout-only gutters", () => {
    expect(
      formatTypecheckDiagnostics(
        [
          "ty 0.1.0",
          "Checking 15 files",
          "",
          "error[unresolved-reference]: Name `foo` used when not defined",
          "  --> app/main.py:10:5",
          "   |",
          "10 |     foo()",
          "   |     ^^^",
          "   |",
          "",
          "warning[unused-variable]: Variable `x` is not used",
          "  --> app/utils.py:8:9",
          "   |",
          " 8 |     x = 42",
          "   |     ^",
          "   |",
          "",
          "Found 1 error, 1 warning",
        ].join("\n"),
        ["ty", "check"],
      ),
    ).toBe(
      [
        "1 error, 1 warning",
        "app/main.py:10:5 error[unresolved-reference]: Name `foo` used when not defined",
        "  10 |     foo()",
        "     |     ^^^",
        "app/utils.py:8:9 warning[unused-variable]: Variable `x` is not used",
        "   8 |     x = 42",
        "     |     ^",
      ].join("\n"),
    );
  });

  test("keeps every TypeScript diagnostic without a line or item cap", () => {
    const diagnostics = Array.from(
      { length: 75 },
      (_, index) =>
        `src/file-${index + 1}.ts(${index + 1},1): error TS2322: Complete diagnostic ${index + 1}.`,
    );
    const formatted = formatTypecheckDiagnostics(
      [...diagnostics, "Found 75 errors in 75 files."].join("\n"),
      ["tsc", "--noEmit"],
    );
    expect(formatted).toContain("75 errors in 75 files");
    expect(formatted).toContain("src/file-1.ts:1:1 error[TS2322]: Complete diagnostic 1.");
    expect(formatted).toContain("src/file-75.ts:75:1 error[TS2322]: Complete diagnostic 75.");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("keeps every Basedpyright and ty diagnostic without a line or item cap", () => {
    const basedpyright = Array.from(
      { length: 75 },
      (_, index) =>
        `  /workspace/file-${index + 1}.py:${index + 1}:2 - error: Complete Python diagnostic ${index + 1} (reportAssignmentType)`,
    );
    const basedpyrightOutput = formatTypecheckDiagnostics(
      [...basedpyright, "75 errors, 0 warnings, 0 informations"].join("\n"),
      ["basedpyright"],
    );
    expect(basedpyrightOutput).toContain(
      "/workspace/file-75.py:75:2 error[reportAssignmentType]: Complete Python diagnostic 75",
    );
    expect(basedpyrightOutput).not.toContain("omitted");

    const ty = Array.from({ length: 75 }, (_, index) => [
      `error[unresolved-reference]: Complete ty diagnostic ${index + 1}`,
      `  --> app/file-${index + 1}.py:${index + 1}:3`,
      `${index + 1} | bad_name`,
      "   | ^^^^^^^^",
    ]).flat();
    const tyOutput = formatTypecheckDiagnostics([...ty, "Found 75 errors, 0 warnings"].join("\n"), [
      "ty",
      "check",
    ]);
    expect(tyOutput).toContain(
      "app/file-75.py:75:3 error[unresolved-reference]: Complete ty diagnostic 75",
    );
    expect(tyOutput).not.toContain("omitted");
  });

  test("recognizes a Bun script echo that the projection may remove after success", () => {
    expect(formatTypecheckDiagnostics("$ tsc --noEmit\n", ["bun", "run", "typecheck"])).toBe("");
  });

  test("rejects unknown output instead of hiding unparsed facts", () => {
    expect(
      formatTypecheckDiagnostics(
        "src/a.ts(1,1): error TS2322: Broken.\nUnrecognized terminal fact",
        ["tsc"],
      ),
    ).toBeNull();
  });
});
