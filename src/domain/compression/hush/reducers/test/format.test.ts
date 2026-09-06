/** Fidelity fixtures for every supported test-runner family. */

import { describe, expect, test } from "bun:test";

import { formatTestOutput } from "./format.ts";

const SUCCESS_CASES = [
  {
    name: "generic",
    tokens: ["test", "custom-runner"],
    source: "custom runner v2\nTests: 2 passed, 0 failed\n",
    expected: "custom runner v2\n2 passed, 0 failed",
  },
  {
    name: "jest",
    tokens: ["jest"],
    source:
      "PASS src/a.test.ts\n  ✓ complete\nTest Suites: 1 passed, 1 total\nTests: 2 passed, 2 total\nSnapshots: 0 total\nTime: 0.45 s\nRan all test suites.\n",
    expected: "2 passed 0.45s",
  },
  {
    name: "vitest",
    tokens: ["vitest", "run"],
    source:
      " RUN  v4.0.0 /workspace\n ✓ src/a.test.ts (2 tests)\n Test Files  1 passed (1)\n Tests  2 passed (2)\n Duration  0.50s\n",
    expected: "2 passed",
  },
  {
    name: "playwright",
    tokens: ["playwright", "test"],
    source:
      "Running 2 tests using 1 worker\n  ✓ login works\n  ✓ logout works\n  2 passed (1.00s)\n",
    expected: "2 passed 1.00s",
  },
  {
    name: "mocha",
    tokens: ["mocha"],
    source: "  context\n    ✓ preserves facts\n    ✓ bounds output\n\n  2 passing (12ms)\n",
    expected: "  context\n2 passed 12ms",
  },
  {
    name: "bun",
    tokens: ["bun", "test"],
    source:
      "bun test v1.4.0\n✓ complete\n✓ budget\n\n2 pass\n0 fail\n4 expect() calls\nRan 2 tests across 1 file. [12.00ms]\n",
    expected: "2 passed 12.00ms",
  },
  {
    name: "pytest",
    tokens: ["pytest"],
    source:
      "tests/test_hush.py::test_complete PASSED\ntests/test_hush.py::test_budget PASSED\n2 passed in 0.12s\n",
    expected: "2 passed 0.12s",
  },
  {
    name: "cargo test",
    tokens: ["cargo", "test"],
    source:
      "running 2 tests\ntest complete ... ok\ntest budget ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n",
    expected: "2 passed 0.01s",
  },
  {
    name: "cargo nextest",
    tokens: ["cargo", "nextest", "run"],
    source:
      "Starting 2 tests across 1 binary\n        PASS complete\n        PASS budget\nSummary [0.12s] 2 tests run: 2 passed, 0 skipped\n",
    expected: "2 passed 0.12s",
  },
  {
    name: "go",
    tokens: ["go", "test", "./..."],
    source:
      "=== RUN   TestComplete\n--- PASS: TestComplete (0.01s)\n=== RUN   TestBudget\n--- PASS: TestBudget (0.01s)\nPASS\nok\texample/falryn\t0.02s\n",
    expected: "2 passed 1 package 0.02s",
  },
  {
    name: "gradle",
    tokens: ["gradle", "test"],
    source:
      "> Task :compileJava UP-TO-DATE\n> Task :test\nBUILD SUCCESSFUL in 1s\n4 actionable tasks: 4 executed\n",
    expected: "ok 1s",
  },
  {
    name: "maven",
    tokens: ["mvn", "test"],
    source:
      "[INFO] Scanning for projects...\n[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.12 s - in dev.falryn.HushTest\n[INFO] BUILD SUCCESS\n[INFO] Total time:  1.20 s\n",
    expected: "2 passed 0.12s dev.falryn.HushTest\nBUILD SUCCESS\ntotal 1.20s",
  },
  {
    name: "sbt",
    tokens: ["sbt", "test"],
    source:
      "[info] Total number of tests run: 2\n[info] Tests: succeeded 2, failed 0, canceled 0, ignored 0, pending 0\n[success] Total time: 1 s\n",
    expected: "2 passed 1s",
  },
  {
    name: "dotnet",
    tokens: ["dotnet", "test"],
    source:
      "Test run for Falryn.Tests.dll (.NETCoreApp,Version=v10.0)\nPassed! - Failed: 0, Passed: 2, Skipped: 0, Total: 2, Duration: 12 ms - Falryn.Tests.dll\n",
    expected: "2 passed 12ms",
  },
  {
    name: "swift",
    tokens: ["swift", "test"],
    source:
      "Test Suite 'All tests' passed at 2026-08-25.\n\t Executed 2 tests, with 0 failures (0 unexpected) in 0.010 (0.012) seconds\n",
    expected: "2 passed 0.010s",
  },
  {
    name: "phpunit",
    tokens: ["phpunit"],
    source: "PHPUnit 12.2.0\n.. 2 / 2 (100%)\nOK (2 tests, 4 assertions)\n",
    expected: "2 passed 4 assertions",
  },
  {
    name: "pest",
    tokens: ["pest"],
    source: "Pest 5.0.0\n..\nTests: 2 passed (4 assertions)\nDuration: 0.12s\n",
    expected: "2 passed 4 assertions\n0.12s",
  },
  {
    name: "minitest",
    tokens: ["rails", "test"],
    source:
      "Run options: --seed 736\n# Running:\n..\nFinished in 0.012s, 166 runs/s\n2 runs, 4 assertions, 0 failures, 0 errors, 0 skips\n",
    expected: "2 passed 0.012s",
  },
  {
    name: "rspec",
    tokens: ["rspec"],
    source: "..\nFinished in 0.012 seconds\n2 examples, 0 failures\n",
    expected: "2 passed 0.012s",
  },
] as const;

const FAILURE_CASES = [
  {
    name: "jest",
    tokens: ["jest"],
    source:
      "FAIL src/hush.test.ts\n  ● hush › complete\n    Expected true but received false\n    at src/hush.test.ts:10:4\nTests: 1 failed, 1 passed, 2 total\nTime: 0.45 s\n",
    markers: [
      "FAIL src/hush.test.ts",
      "Expected true but received false",
      "src/hush.test.ts:10:4",
      "1 passed 1 failed 0.45s",
    ],
  },
  {
    name: "pytest",
    tokens: ["pytest"],
    source:
      "=== FAILURES ===\n________________ test_complete ________________\nE assert False\ntests/test_hush.py:10: AssertionError\n1 failed, 1 passed in 0.12s\n",
    markers: ["test_complete", "assert False", "tests/test_hush.py:10", "1 failed 1 passed 0.12s"],
  },
  {
    name: "cargo",
    tokens: ["cargo", "test"],
    source:
      "running 2 tests\ntest complete ... FAILED\nfailures:\n---- complete stdout ----\nassertion failed: complete\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n",
    markers: ["test complete ... FAILED", "assertion failed: complete", "1 passed 1 failed 0.01s"],
  },
  {
    name: "go",
    tokens: ["go", "test", "./..."],
    source:
      "=== RUN   TestComplete\n--- FAIL: TestComplete (0.01s)\n    hush_test.go:10: expected complete\nFAIL\nFAIL\texample/falryn\t0.02s\n",
    markers: ["TestComplete", "hush_test.go:10", "0 passed 1 failed 1 package 0.02s"],
  },
  {
    name: "gradle",
    tokens: ["gradle", "test"],
    source:
      "> Task :test FAILED\nHushTest > complete FAILED\njava.lang.AssertionError: expected complete\nBUILD FAILED in 1s\n",
    markers: ["> Task :test FAILED", "HushTest > complete FAILED", "AssertionError", "failed 1s"],
  },
  {
    name: "maven",
    tokens: ["mvn", "test"],
    source:
      "[INFO] Running dev.falryn.HushTest\n[ERROR] complete -- expected complete\n[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.12 s <<< FAILURE! -- in dev.falryn.HushTest\n[INFO] BUILD FAILURE\n",
    markers: [
      "complete -- expected complete",
      "1 passed 1 failed 0.12s dev.falryn.HushTest",
      "BUILD FAILURE",
    ],
  },
  {
    name: "sbt",
    tokens: ["sbt", "test"],
    source:
      "[error] HushSpec: expected complete\n[info] Tests: succeeded 1, failed 1, canceled 0, ignored 0, pending 0\n[success] Total time: 1 s\n",
    markers: ["HushSpec: expected complete", "1 passed 1 failed 1s"],
  },
  {
    name: "apple",
    tokens: ["swift", "test"],
    source:
      "Test Case 'HushTests.complete' failed (0.005 seconds)\nXCTAssertTrue failed - expected complete\n Executed 2 tests, with 1 failure (1 unexpected) in 0.010 (0.012) seconds\n",
    markers: [
      "HushTests.complete",
      "XCTAssertTrue failed",
      "1 passed 1 failed 0.010s 1 unexpected",
    ],
  },
  {
    name: "phpunit",
    tokens: ["phpunit"],
    source:
      "PHPUnit 12.2.0\n.F\nThere was 1 failure:\n1) HushTest::complete\nFailed asserting that false is true.\nFAILURES!\nTests: 2, Assertions: 4, Failures: 1.\n",
    markers: [
      "HushTest::complete",
      "Failed asserting that false is true",
      "Tests: 2, Assertions: 4, Failures: 1",
    ],
  },
  {
    name: "rspec",
    tokens: ["rspec"],
    source:
      ".F\nFailures:\n1) hush complete\n   Failure/Error: expect(complete).to be(true)\n   # ./spec/hush_spec.rb:10\nFinished in 0.012 seconds\n2 examples, 1 failure\n",
    markers: [
      "hush complete",
      "expect(complete)",
      "spec/hush_spec.rb:10",
      "1 passed 1 failed 0.012s",
    ],
  },
] as const;

describe("test output formatting", () => {
  for (const fixture of SUCCESS_CASES) {
    test(`compacts complete ${fixture.name} output`, () => {
      expect(formatTestOutput(fixture.source, fixture.tokens)).toBe(fixture.expected);
    });
  }

  for (const fixture of FAILURE_CASES) {
    test(`retains actionable ${fixture.name} failures`, () => {
      const formatted = formatTestOutput(fixture.source, fixture.tokens);
      expect(formatted).not.toBeNull();
      for (const marker of fixture.markers) expect(formatted).toContain(marker);
      expect(formatted).not.toContain("omitted");
    });
  }

  test("retains every failure detail without a fixed failure-count cap", () => {
    const failures = Array.from(
      { length: 75 },
      (_, index) => `${index + 1}) HushTest::failure${index + 1}\nassertion ${index + 1}`,
    );
    const source = ["PHPUnit 12.2.0", "There were 75 failures:", ...failures, "FAILURES!"].join(
      "\n",
    );
    const formatted = formatTestOutput(source, ["phpunit"]);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("1) HushTest::failure1\nassertion 1");
    expect(formatted).toContain("75) HushTest::failure75\nassertion 75");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("more failures");
  });

  test("refuses to reinterpret an unknown runner shape", () => {
    expect(formatTestOutput("opaque runner fact\n", ["pytest"])).toBeNull();
  });
});
