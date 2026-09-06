import { basename } from "node:path";

import {
  ecsOutput,
  mypyOutput,
  phpstanOutput,
  pintOutput,
  rustDiagnosticOutput,
  rustfmtOutput,
} from "./diagnostics.ts";

export function genericTestOutput(): string {
  return [
    "Falryn custom runner v2",
    "running complete",
    "running budget",
    "Tests: 2 passed, 0 failed",
  ].join("\n");
}

export function jestOutput(argv: readonly string[]): string {
  if (argv.includes("--json")) {
    return JSON.stringify({
      testResults: [
        {
          name: "/workspace/src/hush.test.ts",
          assertionResults: [
            { fullName: "hush complete", status: "passed", failureMessages: [] },
            { fullName: "hush budget", status: "passed", failureMessages: [] },
          ],
        },
      ],
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
    });
  }
  return [
    "PASS src/hush.test.ts",
    "  ✓ hush complete",
    "  ✓ hush budget",
    "Test Suites: 1 passed, 1 total",
    "Tests: 2 passed, 2 total",
    "Snapshots: 0 total",
    "Time: 0.45 s",
    "Ran all test suites.",
  ].join("\n");
}

export function vitestOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "--reporter=json" || argument === "--reporter")) {
    return JSON.stringify({
      testResults: [
        {
          name: "/workspace/src/hush.test.ts",
          assertionResults: [
            { fullName: "hush complete", status: "passed", failureMessages: [] },
            { fullName: "hush budget", status: "passed", failureMessages: [] },
          ],
        },
      ],
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
    });
  }
  return [
    " RUN  v4.0.0 /workspace",
    " ✓ src/hush.test.ts (2 tests)",
    " Test Files  1 passed (1)",
    " Tests  2 passed (2)",
    " Duration  0.50s",
  ].join("\n");
}

export function playwrightOutput(argv: readonly string[]): string {
  if (argv.some((argument) => argument === "--reporter=json")) {
    return JSON.stringify({
      stats: { expected: 2, unexpected: 0, skipped: 0, duration: 1_000 },
      suites: [
        {
          title: "hush.spec.ts",
          file: "tests/hush.spec.ts",
          specs: [
            { title: "complete", ok: true, tests: [] },
            { title: "budget", ok: true, tests: [] },
          ],
        },
      ],
    });
  }
  return [
    "Running 2 tests using 1 worker",
    "  ✓ hush complete",
    "  ✓ hush budget",
    "  2 passed (1.00s)",
  ].join("\n");
}

export function mochaOutput(): string {
  return ["  hush", "    ✓ complete", "    ✓ budget", "", "  2 passing (12ms)"].join("\n");
}

export function pytestOutput(): string {
  return [
    "tests/test_hush.py::test_complete PASSED",
    "tests/test_hush.py::test_budget PASSED",
    "2 passed in 0.12s",
  ].join("\n");
}

export function pythonOutput(argv: readonly string[]): string {
  if (argv[0] === "-m" && argv[1] === "pytest") return pytestOutput();
  if (argv[0] === "-m" && argv[1] === "mypy") return mypyOutput();
  throw new Error(`unsupported python fixture arguments: ${argv.join(" ")}`);
}

export function cargoOutput(argv: readonly string[]): string {
  if (argv[0] === "test") {
    return [
      "   Compiling falryn v0.1.0 (/workspace)",
      "    Finished `test` profile target(s) in 0.42s",
      "     Running unittests src/lib.rs",
      "running 2 tests",
      "test complete ... ok",
      "test budget ... ok",
      "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
    ].join("\n");
  }
  if (argv[0] === "nextest") {
    return [
      "Starting 2 tests across 1 binary",
      "        PASS complete",
      "        PASS budget",
      "Summary [0.12s] 2 tests run: 2 passed, 0 skipped",
    ].join("\n");
  }
  if (argv[0] === "clippy" || argv[0] === "check") return rustDiagnosticOutput();
  if (argv[0] === "fmt") return rustfmtOutput();
  if (argv[0] === "install") {
    return [
      "    Updating crates.io index",
      "  Installing hush-cli v0.3.0",
      " Downloaded terminal_size v0.4.0",
      "   Compiling terminal_size v0.4.0",
      "   Compiling hush-cli v0.3.0",
      "    Finished `release` profile [optimized] target(s) in 4.2s",
      "  Installing /workspace/.cargo/bin/hush",
      "   Installed package `hush-cli v0.3.0` (executable `hush`)",
    ].join("\n");
  }
  return [
    "   Compiling serde v1.0.219",
    "   Compiling falryn v0.3.0 (/workspace)",
    "    Finished `release` profile target(s) in 0.42s",
  ].join("\n");
}

export function goOutput(argv: readonly string[]): string {
  if (argv[0] === "vet") {
    return [
      "# example/falryn",
      "./main.go:14:6: fmt.Printf format %d has arg name of wrong type string",
      "./router.go:28:3: result of save call not used",
    ].join("\n");
  }
  if (argv.includes("-json")) {
    return [
      { Action: "run", Package: "example/falryn", Test: "TestComplete" },
      { Action: "pass", Package: "example/falryn", Test: "TestComplete", Elapsed: 0.01 },
      { Action: "run", Package: "example/falryn", Test: "TestBudget" },
      { Action: "pass", Package: "example/falryn", Test: "TestBudget", Elapsed: 0.01 },
      { Action: "pass", Package: "example/falryn", Elapsed: 0.02 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
  }
  if (argv[0] === "build") return "";
  return [
    "=== RUN   TestComplete",
    "--- PASS: TestComplete (0.01s)",
    "=== RUN   TestBudget",
    "--- PASS: TestBudget (0.01s)",
    "PASS",
    "ok\texample/falryn\t0.02s",
  ].join("\n");
}

export function gradleOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "Starting a Gradle Daemon (subsequent builds will be faster)",
      "> Task :compileJava UP-TO-DATE",
      "> Task :processResources NO-SOURCE",
      "> Task :test",
      "BUILD SUCCESSFUL in 1s",
      "4 actionable tasks: 4 executed",
    ].join("\n");
  }
  return [
    "> Task :compileJava",
    "> Task :processResources",
    "> Task :classes",
    "> Task :jar",
    "BUILD SUCCESSFUL in 2s",
    "4 actionable tasks: 4 executed",
  ].join("\n");
}

export function mavenOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "[INFO] Scanning for projects...",
      "[INFO] -----------------------< dev.falryn:core >-----------------------",
      "[INFO] Running dev.falryn.HushTest",
      "[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.12 s - in dev.falryn.HushTest",
      "[INFO] BUILD SUCCESS",
      "[INFO] Total time:  1.20 s",
    ].join("\n");
  }
  return [
    "[INFO] Scanning for projects...",
    "[INFO] Building falryn-core 0.3.0",
    "[INFO] Packaging: jar",
    "[INFO] --- maven-compiler-plugin:3.13.0:compile ---",
    "[INFO] BUILD SUCCESS",
    "[INFO] Total time:  1.42 s",
    "[INFO] Finished at: 2026-08-25T12:00:00-07:00",
  ].join("\n");
}

export function sbtOutput(argv: readonly string[]): string {
  if (argv.some((argument) => /test/i.test(argument))) {
    return [
      "[info] welcome to sbt 1.10.0",
      "[info] loading project definition",
      "[info] Total number of tests run: 2",
      "[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0",
      "[success] Total time: 1 s",
    ].join("\n");
  }
  return [
    "[info] welcome to sbt 1.10.0",
    "[info] compiling 42 Scala sources to /workspace/target/classes",
    "[success] Total time: 2 s, completed Aug 25, 2026",
  ].join("\n");
}

export function dotnetOutput(argv: readonly string[]): string {
  if (argv[0] === "format") {
    return [
      "/workspace/App.cs(14,6): warning IDE0055: Fix formatting",
      "/workspace/Router.cs(28,3): error CS0103: The name 'missing' does not exist in the current context",
      "Format complete in 42 ms.",
    ].join("\n");
  }
  if (argv[0] === "build") {
    return [
      "  Determining projects to restore...",
      "  All projects are up-to-date for restore.",
      "  Falryn -> /workspace/bin/Release/net10.0/Falryn.dll",
      "Build succeeded.",
      "    0 Warning(s)",
      "    0 Error(s)",
      "Time Elapsed 00:00:01.42",
    ].join("\n");
  }
  if (argv[0] === "restore") {
    return [
      "  Determining projects to restore...",
      "  Restored /workspace/Falryn.csproj (in 142 ms).",
      "  Restored /workspace/Falryn.Tests.csproj (in 184 ms).",
    ].join("\n");
  }
  return [
    "Determining projects to restore...",
    "All projects are up-to-date for restore.",
    "Test run for Falryn.Tests.dll (.NETCoreApp,Version=v10.0)",
    "Passed! - Failed: 0, Passed: 2, Skipped: 0, Total: 2, Duration: 12 ms - Falryn.Tests.dll",
  ].join("\n");
}

function appleTestOutput(): string {
  return [
    "Building for debugging...",
    "Build complete! (0.42s)",
    "Test Suite 'All tests' started at 2026-08-25",
    "Test Case 'HushTests.complete' passed (0.005 seconds)",
    "Test Case 'HushTests.budget' passed (0.005 seconds)",
    "Test Suite 'All tests' passed at 2026-08-25",
    "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.010 (0.012) seconds",
    "** TEST SUCCEEDED **",
  ].join("\n");
}

export function swiftOutput(argv: readonly string[]): string {
  if (argv.includes("test")) return appleTestOutput();
  return [
    "Building for production...",
    "[1/4] Write sources",
    "[2/4] Compiling Falryn main.swift",
    "[3/4] Linking falryn",
    "[4/4] Write Objects.LinkFileList",
    "Build complete! (0.42s)",
  ].join("\n");
}

export function xcodeOutput(argv: readonly string[]): string {
  if (argv.includes("test")) return appleTestOutput();
  return [
    "Command line invocation:",
    "    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build",
    "Build settings from command line:",
    "    CONFIGURATION = Release",
    "=== BUILD TARGET Falryn OF PROJECT Falryn ===",
    "CompileSwift normal arm64 /workspace/Sources/Falryn.swift",
    "Ld /workspace/build/Release/Falryn normal arm64",
    "** BUILD SUCCEEDED **",
  ].join("\n");
}

export function phpWrapperOutput(argv: readonly string[]): string {
  if (argv[0] === "-l") {
    return `No syntax errors detected in ${argv[1] ?? "app.php"}`;
  }
  if (argv[0] === "artisan") {
    return ["INFO", "Configuration cached successfully."].join("\n");
  }
  const tool = basename(argv[0] ?? "");
  if (tool === "phpunit") return phpunitOutput();
  if (tool === "pest") return pestOutput();
  if (tool === "paratest") return paratestOutput();
  if (tool === "phpstan") return phpstanOutput(argv.slice(1));
  if (tool === "ecs") return ecsOutput();
  if (tool === "pint") return pintOutput(argv.slice(1));
  return "Falryn PHP application result: context ready";
}

export function phpunitOutput(): string {
  return [
    "PHPUnit 12.2.0 by Sebastian Bergmann and contributors.",
    "Runtime: PHP 8.4.0",
    ".. 2 / 2 (100%)",
    "Time: 00:00:00.120, Memory: 8.00 MB",
    "OK (2 tests, 4 assertions)",
  ].join("\n");
}

export function pestOutput(): string {
  return ["Pest 5.0.0", "..", "Tests: 2 passed (4 assertions)", "Duration: 0.12s"].join("\n");
}

export function paratestOutput(): string {
  return [
    "ParaTest v7.3.0 upon PHPUnit 12.2.0",
    "Random Seed: 736",
    ".. 2 / 2 (100%)",
    "OK (2 tests, 4 assertions)",
  ].join("\n");
}

export function minitestOutput(): string {
  return [
    "Run options: --seed 736",
    "# Running:",
    "..",
    "Finished in 0.012s, 166 runs/s",
    "2 runs, 4 assertions, 0 failures, 0 errors, 0 skips",
  ].join("\n");
}

export function rspecOutput(argv: readonly string[]): string {
  if (argv.includes("json")) {
    return JSON.stringify({
      examples: [
        {
          full_description: "hush complete",
          status: "passed",
          file_path: "spec/hush_spec.rb",
          line_number: 4,
        },
        {
          full_description: "hush budget",
          status: "passed",
          file_path: "spec/hush_spec.rb",
          line_number: 8,
        },
      ],
      summary: {
        duration: 0.012,
        example_count: 2,
        failure_count: 0,
        pending_count: 0,
        errors_outside_of_examples_count: 0,
      },
    });
  }
  return ["..", "Finished in 0.012 seconds", "2 examples, 0 failures"].join("\n");
}
