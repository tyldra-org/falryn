/**
 * Application-boundary Git dashboard: observe through GitPort, mutate only via it.
 */

import { describe, expect, test } from "bun:test";
import {
  type GitIdentity,
  type GitPort,
  type GitStatusEntry,
  instant,
  localPath,
  ok,
} from "../domain/index.ts";
import { createGitDashboard, describeGitError } from "./git-dashboard.ts";

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

function unused(): never {
  throw new Error("unexpected GitPort call");
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

function fakeGit(overrides: Partial<GitPort>): GitPort {
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
    planCommits: fail,
    stage: async () => unused(),
    unstage: fail,
    commit: async () => unused(),
    fetch: fail,
    pull: fail,
    push: fail,
    sync: fail,
    ...overrides,
  };
}

describe("createGitDashboard", () => {
  test("loads status, worktrees, and checkpoints without staging", async () => {
    const dashboard = createGitDashboard({
      git: fakeGit({
        status: async () =>
          ok({
            identity: identity(),
            entries: { state: "observed", value: [entry("src/a.ts")] },
          }),
        listWorktrees: async () =>
          ok({
            identity: identity(),
            worktrees: {
              state: "observed",
              value: [
                {
                  path: "/repo",
                  head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                  branch: { state: "observed", value: "main" },
                  detached: false,
                  locked: false,
                  prunable: false,
                },
              ],
            },
          }),
        listCheckpoints: async () =>
          ok({
            identity: identity(),
            checkpoints: { state: "observed", value: [] },
          }),
      }),
      gitExecutable: "git",
      startPath: "/repo",
    });

    const snapshot = await dashboard.snapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.value.entries.map((item) => item.path)).toEqual(["src/a.ts"]);
    expect(snapshot.value.worktrees).toHaveLength(1);
    expect(snapshot.value.checkpointsNote).toBeNull();
  });

  test("plans restore before restoring a checkpoint", async () => {
    const order: string[] = [];
    const checkpoint = {
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headState: "branch" as const,
      branch: "main",
      indexTree: "c",
      worktreeTree: "d",
      includedUntracked: [],
      excludedUntracked: 0,
      truncated: false,
      sessionId: null,
      turnId: null,
    };
    const dashboard = createGitDashboard({
      git: fakeGit({
        discover: async () => ok(identity()),
        planRestore: async () => {
          order.push("plan");
          return ok({
            identity: identity(),
            checkpoint,
            indexChanged: false,
            worktreePaths: [],
            untrackedRestores: [],
          });
        },
        restoreCheckpoint: async () => {
          order.push("restore");
          return ok({
            identity: identity(),
            checkpoint,
            restoredIndex: true,
            restoredWorktree: [],
            restoredUntracked: [],
          });
        },
      }),
      gitExecutable: "git",
      startPath: "/repo",
    });

    const restored = await dashboard.restoreCheckpoint(checkpoint.id);
    expect(restored.ok).toBe(true);
    expect(order).toEqual(["plan", "restore"]);
  });
});

describe("describeGitError", () => {
  test("names a failed reason without inventing a spawn", () => {
    expect(describeGitError({ code: "failed", reason: "not a git repo" })).toBe("not a git repo");
    expect(describeGitError({ code: "cancelled" })).toBe("cancelled");
  });
});
