import { basename } from "node:path";

export function genericFormatOutput(): string {
  return "Formatting complete: 42 files checked, 42 unchanged.";
}

export function genericLintOutput(): string {
  return [
    "src/runtime.ts:14:6: error lint/noUnsafe: Unsafe value reaches the provider.",
    "src/router.ts:28:3: warning lint/noFallback: Fallback route is not explicit.",
    "2 issues (1 error, 1 warning)",
  ].join("\n");
}

export function biomeOutput(): string {
  return [
    "src/runtime.ts:14:6 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "  × Unexpected any. Specify a different type.",
    "src/router.ts:28:3 lint/correctness/noUnusedVariables ━━━━━━━━━━━━━━━━━━━━━━━",
    "  × This variable is unused.",
    "Checked 42 files in 18ms. No fixes applied.",
    "Found 2 errors.",
  ].join("\n");
}

export function eslintOutput(): string {
  return [
    "/workspace/src/runtime.ts",
    "  14:6  error    Unsafe any value              @typescript-eslint/no-unsafe-assignment",
    "  28:3  warning  Unexpected console statement  no-console",
    "✖ 2 problems (1 error, 1 warning)",
  ].join("\n");
}

export function oxlintOutput(): string {
  return [
    "src/runtime.ts:14:6: error no-undef: `missing` is not defined",
    "src/router.ts:28:3: warning no-console: Unexpected console statement",
    "Found 1 warning and 1 error.",
  ].join("\n");
}

export function prettierOutput(): string {
  return [
    "Checking formatting...",
    "[warn] src/runtime.ts",
    "[warn] src/router.ts",
    "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.",
  ].join("\n");
}

export function rustDiagnosticOutput(): string {
  return [
    "    Checking falryn v0.3.0 (/workspace)",
    "error[E0425]: cannot find value `missing` in this scope",
    "  --> src/lib.rs:14:6",
    "   |",
    "14 |     missing();",
    "   |     ^^^^^^^ not found in this scope",
    "warning: unused variable: `context`",
    "  --> src/router.rs:28:3",
    "   |",
    "28 |   let context = pack();",
    "   |       ^^^^^^^ help: prefix it with an underscore",
    "warning: falryn generated 1 warning",
    "error: could not compile `falryn` due to 1 previous error",
  ].join("\n");
}

export function rustfmtOutput(): string {
  return [
    "Diff in /workspace/src/lib.rs:",
    "-fn project(){",
    "+fn project() {",
    "     preserve_context();",
    " }",
  ].join("\n");
}

export function mypyOutput(): string {
  return [
    'src/app.py:14:6: error: Name "missing" is not defined  [name-defined]',
    "src/router.py:28:3: error: Incompatible return value type  [return-value]",
    "Found 2 errors in 2 files (checked 42 source files)",
  ].join("\n");
}

export function ruffOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("output-format=json"))) {
    return JSON.stringify([
      {
        code: "F821",
        filename: "src/app.py",
        location: { row: 14, column: 6 },
        end_location: { row: 14, column: 13 },
        message: "Undefined name `missing`",
        fix: null,
        noqa_row: 14,
        url: "https://docs.astral.sh/ruff/routing/undefined-name",
      },
      {
        code: "E501",
        filename: "src/router.py",
        location: { row: 28, column: 3 },
        end_location: { row: 28, column: 92 },
        message: "Line too long (92 > 88)",
        fix: null,
        noqa_row: 28,
        url: "https://docs.astral.sh/ruff/routing/line-too-long",
      },
    ]);
  }
  if (argv[0] === "format") {
    return [
      "Would reformat: src/app.py",
      "Would reformat: src/router.py",
      "2 files would be reformatted",
    ].join("\n");
  }
  return [
    "src/app.py:14:6: F821 Undefined name `missing`",
    "src/router.py:28:3: E501 Line too long (92 > 88)",
    "Found 2 errors.",
    "[*] 0 fixable with the `--fix` option.",
  ].join("\n");
}

export function golangciOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("out-format=json"))) {
    return JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "printf: fmt.Printf format %d has arg name of wrong type string",
          Pos: { Filename: "main.go", Line: 14, Column: 6 },
        },
        {
          FromLinter: "errcheck",
          Text: "Error return value of `save` is not checked",
          Pos: { Filename: "router.go", Line: 28, Column: 3 },
        },
      ],
      Report: {
        Linters: [
          { Name: "govet", Enabled: true },
          { Name: "errcheck", Enabled: true },
        ],
      },
    });
  }
  return [
    "main.go:14:6: printf: fmt.Printf format %d has arg name of wrong type string (govet)",
    "router.go:28:3: Error return value of `save` is not checked (errcheck)",
    "2 issues:",
    "* errcheck: 1",
    "* govet: 1",
  ].join("\n");
}

export function phpstanOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("error-format") || argument === "json")) {
    return JSON.stringify({
      totals: { errors: 0, file_errors: 2 },
      files: {
        "/workspace/src/App.php": {
          errors: 1,
          messages: [
            {
              message: "Call to an undefined method App::missing().",
              line: 14,
              ignorable: true,
              identifier: "method.notFound",
            },
          ],
        },
        "/workspace/src/Router.php": {
          errors: 1,
          messages: [
            {
              message: "Method Router::route() should return string but returns int.",
              line: 28,
              ignorable: true,
              identifier: "return.type",
            },
          ],
        },
      },
      errors: [],
    });
  }
  return [
    " ------ ---------------------------------------------------------------- ",
    "  Line   /workspace/src/App.php                                         ",
    " ------ ---------------------------------------------------------------- ",
    "  14     Call to an undefined method App::missing().                    ",
    "         🪪  method.notFound                                             ",
    " ------ ---------------------------------------------------------------- ",
    "  Line   /workspace/src/Router.php                                      ",
    " ------ ---------------------------------------------------------------- ",
    "  28     Method Router::route() should return string but returns int.   ",
    "         🪪  return.type                                                 ",
    " ------ ---------------------------------------------------------------- ",
    " [ERROR] Found 2 errors",
  ].join("\n");
}

export function ecsOutput(): string {
  return [
    "2 files with errors",
    "===================",
    "1) src/App.php",
    "---------- begin diff ----------",
    "-final class App{",
    "+final class App {",
    "----------- end diff -----------",
    "2) src/Router.php",
    "---------- begin diff ----------",
    "-return$context;",
    "+return $context;",
    "----------- end diff -----------",
  ].join("\n");
}

export function pintOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument.includes("format=json"))) {
    return JSON.stringify({
      files: [
        { name: "src/App.php", status: "failed", appliedFixers: ["class_attributes_separation"] },
        {
          name: "src/Router.php",
          status: "failed",
          appliedFixers: ["single_space_around_construct"],
        },
      ],
    });
  }
  return [
    "  ⨯⨯",
    "  ─────────────────────────────────────────────────────────── Laravel",
    "    FAIL  ........................................ 2 files, 2 style issues",
    "  ⨯ src/App.php                         class_attributes_separation",
    "  ⨯ src/Router.php                     single_space_around_construct",
  ].join("\n");
}

export function rubocopOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "json" || argument.includes("format=json"))) {
    return JSON.stringify({
      metadata: { rubocop_version: "1.80.0", ruby_engine: "ruby", ruby_version: "3.4.0" },
      files: [
        {
          path: "app.rb",
          offenses: [
            {
              severity: "convention",
              message: "Layout/TrailingWhitespace: Trailing whitespace detected.",
              cop_name: "Layout/TrailingWhitespace",
              corrected: false,
              correctable: true,
              location: { start_line: 14, start_column: 6, line: 14, column: 6, length: 1 },
            },
          ],
        },
        {
          path: "router.rb",
          offenses: [
            {
              severity: "warning",
              message: "Lint/UselessAssignment: Useless assignment to variable - context.",
              cop_name: "Lint/UselessAssignment",
              corrected: false,
              correctable: true,
              location: { start_line: 28, start_column: 3, line: 28, column: 3, length: 7 },
            },
          ],
        },
      ],
      summary: { offense_count: 2, target_file_count: 2, inspected_file_count: 2 },
    });
  }
  return [
    "Inspecting 2 files",
    "CW",
    "Offenses:",
    "app.rb:14:6: C: [Correctable] Layout/TrailingWhitespace: Trailing whitespace detected.",
    "router.rb:28:3: W: [Correctable] Lint/UselessAssignment: Useless assignment to variable - context.",
    "2 files inspected, 2 offenses detected, 2 offenses autocorrectable",
  ].join("\n");
}

export function precommitOutput(): string {
  return [
    "Trim trailing whitespace.................................................Failed",
    "- hook id: trailing-whitespace",
    "- exit code: 1",
    "- files were modified by this hook",
    "Check YAML...............................................................Passed",
  ].join("\n");
}

export function hadolintOutput(): string {
  return [
    "Dockerfile:14 DL3008 warning: Pin versions in apt get install.",
    "Dockerfile:28 DL3015 info: Avoid additional packages by specifying --no-install-recommends.",
  ].join("\n");
}

export function markdownlintOutput(): string {
  return [
    "README.md:14:6 MD013/line-length Line length [Expected: 80; Actual: 92]",
    "docs/guide.md:28 MD022/blanks-around-headings Headings should be surrounded by blank lines",
  ].join("\n");
}

export function shellcheckOutput(): string {
  return [
    "In scripts/build.sh line 14:",
    "echo $artifact",
    "     ^-------^ SC2086 (info): Double quote to prevent globbing and word splitting.",
  ].join("\n");
}

export function yamllintOutput(): string {
  return [
    ".github/workflows/check.yml",
    '  14:6      warning  missing document start "---"  (document-start)',
    "  28:3      error    trailing spaces  (trailing-spaces)",
  ].join("\n");
}

export function diagnosticFailure(command: string, argv: readonly string[]): boolean {
  if (
    [
      "lint",
      "biome",
      "eslint",
      "oxlint",
      "prettier",
      "clippy",
      "mypy",
      "ruff",
      "golangci-lint",
      "golangci",
      "phpstan",
      "ecs",
      "pint",
      "rubocop",
      "pre-commit",
      "hadolint",
      "markdownlint",
      "shellcheck",
      "yamllint",
    ].includes(command)
  ) {
    return true;
  }
  if (command === "cargo") return ["clippy", "check", "fmt"].includes(argv[0] ?? "");
  if (command === "python") return argv[0] === "-m" && argv[1] === "mypy";
  if (command === "go") return argv[0] === "vet";
  if (command === "mix") return argv[0] === "format";
  if (command === "dotnet") return argv[0] === "format";
  if (command === "bun") return argv[0] === "run" && ["check", "lint"].includes(argv[1] ?? "");
  if (command === "bundle") return argv[0] === "exec" && argv[1] === "rubocop";
  if (command === "php") {
    return ["phpstan", "ecs", "pint"].includes(basename(argv[0] ?? ""));
  }
  if (command === "build") return argv.includes("--fail");
  if (command === "err") return argv.includes("--fail");
  return false;
}
