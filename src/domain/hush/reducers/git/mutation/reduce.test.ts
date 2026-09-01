import { describe, expect, test } from "bun:test";

import { duration, instant } from "../../../../clock.ts";
import { processCaptureId } from "../../../../identity.ts";
import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import { gitMutationProjection } from "../mutation.ts";

const MAX_BYTES = 64 * 1_024;

describe("Hush Git mutation reducer", () => {
  test("dispatches complete Git success output to the matching compact format", () => {
    const cases = [
      {
        tokens: ["git", "branch"],
        report: report("  feature/736\n* main\n"),
        expected: "feature/736\n* main",
      },
      {
        tokens: ["git", "checkout", "feature/736"],
        report: report("", "Switched to branch 'feature/736'\n"),
        expected: "ok feature/736",
      },
      {
        tokens: ["git", "fetch", "-n"],
        report: report(
          "",
          "From github.com:tyldra-org/falryn\n   1111111..2222222  main -> origin/main\n",
        ),
        expected: "fetched 1 ref",
      },
      {
        tokens: ["git", "stash", "push", "-m", "checkpoint"],
        report: report("Saved working directory and index state On main: checkpoint\n"),
        expected: "stashed",
      },
      {
        tokens: ["git", "worktree", "list"],
        report: report("/workspace/falryn 1111111 [main]\n/workspace/review 2222222 [review]\n"),
        expected: ". 1111111 [main]\n/workspace/review 2222222 [review]",
      },
    ] as const;

    for (const fixture of cases) {
      expect(project(fixture.report, fixture.tokens).text).toBe(fixture.expected);
    }
  });

  test("preserves failures, warnings, custom formats, and interactive output", () => {
    const failure = report("partial checkout\n", "fatal: pathspec failed\n", 1);
    expect(project(failure, ["git", "checkout", "missing"]).text).toBe(
      "partial checkout\n\nstderr:\nfatal: pathspec failed\n",
    );

    const warning = "warning: redirecting to https://example.test/falryn.git/\n";
    expect(project(report("", warning), ["git", "fetch"]).text).toBe(`stderr:\n${warning}`);

    const pullDetails = [
      "From github.com:tyldra-org/falryn",
      " * [new branch] feature/736 -> origin/feature/736",
      "Already up to date.",
      "",
    ].join("\n");
    expect(project(report(pullDetails), ["git", "pull"]).text).toBe(pullDetails);

    const custom = "main\t1111111\n";
    expect(project(report(custom), ["git", "branch", "--format", "%(refname:short)"]).text).toBe(
      custom,
    );

    const interactive = "diff --git a/a.ts b/a.ts\n";
    expect(project(report(interactive), ["git", "add", "--patch"]).text).toBe(interactive);

    const dryRun = "Removing worktrees/review: gitdir file points to non-existent location\n";
    expect(project(report(dryRun), ["git", "worktree", "prune", "-n", "-v"]).text).toBe(dryRun);
  });
});

function project(capture: ProcessCaptureReport, tokens: readonly string[]) {
  return gitMutationProjection(capture, MAX_BYTES, [], tokens, "/workspace/falryn");
}

function report(stdout: string, stderr = "", exitCode = 0): ProcessCaptureReport {
  return {
    captureId: processCaptureId.from("git-mutation-test"),
    pid: 42,
    startedAt: instant(1),
    endedAt: instant(2),
    durationMs: duration(1),
    stop: { kind: "exited" },
    killStage: "none",
    exit: { exitCode, signal: null },
    stdout: stream("stdout", stdout),
    stderr: stream("stderr", stderr),
    events: [],
  };
}

function stream(stream: "stdout" | "stderr", text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    stream,
    byteCount: bytes.byteLength,
    inlineBytes: bytes,
    inlineText: text,
    encoding: "utf-8" as const,
    truncated: false,
    omittedBytes: 0,
    maxLineExceeded: false,
    artifact: null,
  };
}
