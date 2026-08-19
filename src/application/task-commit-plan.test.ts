/**
 * Application-boundary Git wiring for commit-plan advice.
 */

import { describe, expect, test } from "bun:test";
import {
  type GitIdentity,
  type GitPort,
  type GitStatusEntry,
  instant,
  localPath,
  planGitCommits,
} from "../domain/index.ts";
import { planOutcomeCommits } from "./task-commit-plan.ts";

function identity(): GitIdentity {
  return {
    worktreeRoot: localPath("/repo"),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    headState: "branch",
    branch: { state: "observed", value: "main" },
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

function entry(path: string): GitStatusEntry {
  return {
    kind: "ordinary",
    path,
    originalPath: null,
    indexStatus: ".",
    worktreeStatus: "M",
  };
}

function unused(): never {
  throw new Error("unexpected GitPort mutation");
}

function fakeGit(
  planCommits: GitPort["planCommits"],
  mutations: { stage?: GitPort["stage"]; commit?: GitPort["commit"] } = {},
): GitPort {
  const fail = async () => ({
    ok: false as const,
    error: { code: "failed" as const, reason: "unused" },
  });
  return {
    discover: fail,
    status: fail,
    diff: fail,
    log: fail,
    blame: fail,
    listWorktrees: fail,
    createBranch: fail,
    switchBranch: fail,
    deleteBranch: fail,
    createWorktree: fail,
    removeWorktree: fail,
    createCheckpoint: fail,
    listCheckpoints: fail,
    planRestore: fail,
    restoreCheckpoint: fail,
    planCommits,
    stage: mutations.stage ?? (async () => unused()),
    unstage: fail,
    commit: mutations.commit ?? (async () => unused()),
    fetch: fail,
    pull: fail,
    push: fail,
    sync: fail,
  };
}

describe("planOutcomeCommits", () => {
  test("refuses a secret-shaped scope path without echoing it", async () => {
    const git = fakeGit(async () => {
      throw new Error("planCommits should not run after a secret scope");
    });
    const result = await planOutcomeCommits(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
      scope: ["token sk-live-SECRET.ts"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("plans actual changes through GitPort.planCommits without staging", async () => {
    const gitIdentity = identity();
    const git = fakeGit(async () => ({
      ok: true,
      value: {
        identity: gitIdentity,
        plan: planGitCommits({
          identity: gitIdentity,
          entries: [entry("src/foo.ts"), entry("src/foo.test.ts")],
          truncated: false,
          subjects: ["feat(runtime): add checkpoints"],
        }),
      },
    }));
    const result = await planOutcomeCommits(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan.groups).toHaveLength(1);
      expect(result.value.plan.groups[0]?.reason).toBe("source-and-test");
    }
  });

  test("maps in-progress git state to unavailable advice", async () => {
    const git = fakeGit(async () => ({
      ok: false,
      error: { code: "operation-in-progress", operation: "merge" },
    }));
    const result = await planOutcomeCommits(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "task-commit-plan",
        code: "unavailable",
        field: "git",
      });
    }
  });
});
