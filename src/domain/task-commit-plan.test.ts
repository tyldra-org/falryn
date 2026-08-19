/**
 * Reviewable commit plans from actual changes, with optional user-selected scope.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { instant } from "./clock.ts";
import { planGitCommits } from "./commit-plan.ts";
import { localPath } from "./filesystem.ts";
import type { GitIdentity, GitStatusEntry } from "./git.ts";
import { outcomeId, taskId } from "./identity.ts";
import {
  planTaskCommits,
  TASK_COMMIT_PLAN_SOURCE,
  TASK_COMMIT_PLAN_VERSION,
} from "./task-commit-plan.ts";

function identity(headState: "branch" | "detached" = "branch"): GitIdentity {
  return {
    worktreeRoot: localPath("/repo"),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    headState,
    branch:
      headState === "branch"
        ? { state: "observed", value: "main" }
        : { state: "unavailable", reason: "detached" },
    upstream: { state: "unavailable", reason: "none" },
    ahead: { state: "unavailable", reason: "none" },
    behind: { state: "unavailable", reason: "none" },
    operation: "clean",
    superproject: { state: "unavailable", reason: "no-superproject" },
    sparseCheckout: { state: "observed", value: false },
    gitVersion: { state: "observed", value: "2.45.0" },
    remotes: { state: "observed", value: [] },
    observedAt: instant(0),
  };
}

function entry(
  path: string,
  kind: GitStatusEntry["kind"] = "ordinary",
  indexStatus = ".",
  worktreeStatus = "M",
): GitStatusEntry {
  return { kind, path, originalPath: null, indexStatus, worktreeStatus };
}

function snapshot(entries: readonly GitStatusEntry[]) {
  const gitIdentity = identity();
  return {
    identity: gitIdentity,
    plan: planGitCommits({
      identity: gitIdentity,
      entries,
      truncated: false,
      subjects: ["feat(runtime): add checkpoints and restore plans"],
    }),
  };
}

describe("planTaskCommits", () => {
  test("attaches outcome lineage to an actual-change plan without regrouping", () => {
    const { identity: gitIdentity, plan } = snapshot([
      entry("src/foo.ts"),
      entry("src/foo.test.ts"),
    ]);
    const result = planTaskCommits({
      outcomeId: "outcome-1",
      taskId: "t1",
      identity: gitIdentity,
      plan,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.outcomeId).toBe(outcomeId.from("outcome-1"));
    expect(result.value.taskId).toBe(taskId.from("t1"));
    expect(result.value.plan.groups).toEqual(plan.groups);
    expect(result.value.omittedPaths).toEqual([]);
    expect(result.value.provenance).toEqual({
      version: TASK_COMMIT_PLAN_VERSION,
      source: TASK_COMMIT_PLAN_SOURCE,
      model: null,
      plannerVersion: 1,
    });
  });

  test("omits unrelated inventory when the user selects a scope", () => {
    const { identity: gitIdentity, plan } = snapshot([
      entry("src/foo.ts"),
      entry("src/foo.test.ts"),
      entry("README.md"),
    ]);
    const result = planTaskCommits({
      outcomeId: "outcome-1",
      identity: gitIdentity,
      plan,
      scope: ["src/foo.ts", "src/foo.test.ts"],
      subjects: ["feat(runtime): add checkpoints and restore plans"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.plan.groups).toEqual([
      {
        id: "group-1",
        paths: ["src/foo.ts", "src/foo.test.ts"],
        reason: "source-and-test",
        subject: "feat(src): update foo",
      },
    ]);
    expect(result.value.omittedPaths).toEqual(["README.md"]);
  });

  test("refuses a scope path that is not an actual change", () => {
    const { identity: gitIdentity, plan } = snapshot([entry("src/foo.ts")]);
    const result = planTaskCommits({
      outcomeId: "outcome-1",
      identity: gitIdentity,
      plan,
      scope: ["src/foo.ts", "src/missing.ts"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "task-commit-plan",
        code: "malformed",
        field: "scope.1",
      });
    }
  });

  test("refuses a model-assisted commit plan", () => {
    const { identity: gitIdentity, plan } = snapshot([entry("src/foo.ts")]);
    const result = planTaskCommits({
      outcomeId: "outcome-1",
      identity: gitIdentity,
      plan,
      model: "small-classifier",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported");
    }
  });

  test("treats cancellation as cancelled, not as completed advice", () => {
    const { identity: gitIdentity, plan } = snapshot([entry("src/foo.ts")]);
    const result = planTaskCommits(
      { outcomeId: "outcome-1", identity: gitIdentity, plan },
      AbortSignal.abort(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("refuses a clean tree as empty rather than an invented group", () => {
    const { identity: gitIdentity, plan } = snapshot([]);
    const result = planTaskCommits({
      outcomeId: "outcome-1",
      identity: gitIdentity,
      plan,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("empty");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./task-commit-plan.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|Bun\.spawn|child_process|fetch\(|git add|git commit)\b/,
    );
  });
});
