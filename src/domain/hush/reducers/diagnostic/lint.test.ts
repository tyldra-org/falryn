import { describe, expect, test } from "bun:test";

import { formatLintDiagnostics } from "./lint.ts";

describe("Hush lint and format diagnostics", () => {
  test.each([
    {
      name: "Biome",
      tokens: ["biome", "check", "."],
      source: [
        "src/runtime.ts:14:6 lint/suspicious/noExplicitAny ━━━━━",
        "  × Unexpected any.",
        "Checked 1 file in 18ms. No fixes applied.",
        "Found 1 error.",
      ].join("\n"),
      markers: ["src/runtime.ts:14:6", "lint/suspicious/noExplicitAny", "Unexpected any."],
    },
    {
      name: "Rust",
      tokens: ["cargo", "clippy"],
      source: [
        "error[E0425]: cannot find value `missing` in this scope",
        "  --> src/lib.rs:14:6",
        "14 | missing();",
        "error: could not compile `falryn` due to 1 previous error",
      ].join("\n"),
      markers: ["E[E0425] src/lib.rs:14:6", "missing();"],
    },
    {
      name: "mypy",
      tokens: ["mypy", "src"],
      source: [
        'src/app.py:14:6: error: Name "missing" is not defined  [name-defined]',
        "Found 1 error in 1 file (checked 42 source files)",
      ].join("\n"),
      markers: ["1 error checked 42 files", "src/app.py:14:6 error[name-defined]"],
    },
    {
      name: "golangci-lint",
      tokens: ["golangci-lint", "run"],
      source: ["main.go:14:6: printf format mismatch (govet)", "1 issue:", "* govet: 1"].join("\n"),
      markers: ["E[govet] main.go:14:6 printf format mismatch"],
    },
    {
      name: "PHPStan",
      tokens: ["phpstan", "analyse", "src"],
      source: [
        "  Line   /workspace/src/App.php",
        "  14     Call to an undefined method App::missing().",
        "         🪪  method.notFound",
        " [ERROR] Found 1 error",
      ].join("\n"),
      markers: ["E[method.notFound] /workspace/src/App.php:14", "App::missing()"],
    },
    {
      name: "Rubocop wrapper",
      tokens: ["rubocop"],
      source: [
        "Inspecting 1 file",
        "C",
        "Offenses:",
        "app.rb:14:6: C: [Correctable] Layout/TrailingWhitespace: Trailing whitespace detected.",
        "1 file inspected, 1 offense detected, 1 offense autocorrectable",
      ].join("\n"),
      markers: ["app.rb:14:6 warning[Layout/TrailingWhitespace]", "1 correctable"],
    },
    {
      name: "pre-commit",
      tokens: ["pre-commit", "run", "--all-files"],
      source: [
        "Trim trailing whitespace................Failed",
        "- hook id: trailing-whitespace",
        "- exit code: 1",
        "Check YAML..............................Passed",
      ].join("\n"),
      markers: ["1 failed, 1 passed", "[trailing-whitespace] exit 1", "passed Check YAML"],
    },
    {
      name: "ShellCheck",
      tokens: ["shellcheck", "scripts/build.sh"],
      source: [
        "In scripts/build.sh line 14:",
        "echo $artifact",
        "     ^-------^ SC2086 (info): Double quote the expansion.",
      ].join("\n"),
      markers: ["I[SC2086] scripts/build.sh:14", "Double quote the expansion.", "echo $artifact"],
    },
  ])("keeps every actionable $name fact", ({ tokens, source, markers }) => {
    const formatted = formatLintDiagnostics(source, tokens);
    expect(formatted).not.toBeNull();
    for (const marker of markers) expect(formatted).toContain(marker);
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("uses concise, readable format projections", () => {
    expect(
      formatLintDiagnostics(
        [
          "Checking formatting...",
          "[warn] src/runtime.ts",
          "[warn] src/router.ts",
          "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.",
        ].join("\n"),
        ["prettier", "--check", "."],
      ),
    ).toBe("fmt 2\nsrc/runtime.ts\nsrc/router.ts");
  });

  test("keeps every diagnostic without an item cap", () => {
    const facts = Array.from(
      { length: 75 },
      (_, index) =>
        `src/file-${index + 1}.ts:${index + 1}:1: error lint/complete: Complete diagnostic ${index + 1}.`,
    );
    const formatted = formatLintDiagnostics(
      [...facts, "75 issues (75 errors, 0 warnings)"].join("\n"),
      ["lint", "src"],
    );
    expect(formatted).toContain("75 errors");
    expect(formatted).toContain("src/file-1.ts:1:1");
    expect(formatted).toContain("src/file-75.ts:75:1");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("rejects unknown output instead of hiding unparsed facts", () => {
    expect(
      formatLintDiagnostics(
        "src/a.ts:1:1: error no-undef: Missing value\nunrecognized terminal fact",
        ["oxlint", "src"],
      ),
    ).toBeNull();
  });
});
