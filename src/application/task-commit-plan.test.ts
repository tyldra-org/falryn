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
import {
  commitPlanConfirmToken,
  executeOutcomeCommitPlan,
  planOutcomeCommits,
} from "./task-commit-plan.ts";

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

  test("maps a clean tree to an empty reviewable plan", async () => {
    const gitIdentity = identity();
    const git = fakeGit(async () => ({
      ok: true,
      value: {
        identity: gitIdentity,
        plan: planGitCommits({
          identity: gitIdentity,
          entries: [],
          truncated: false,
          subjects: [],
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
      expect(result.value.plan.groups).toEqual([]);
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

describe("executeOutcomeCommitPlan", () => {
  test("previews without staging when confirmation is omitted", async () => {
    const gitIdentity = identity();
    let staged = false;
    const git = fakeGit(
      async () => ({
        ok: true,
        value: {
          identity: gitIdentity,
          plan: planGitCommits({
            identity: gitIdentity,
            entries: [entry("src/foo.ts")],
            truncated: false,
            subjects: ["feat: ship"],
          }),
        },
      }),
      {
        stage: async () => {
          staged = true;
          return unused();
        },
      },
    );
    const result = await executeOutcomeCommitPlan(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
      confirmation: null,
    });
    expect(result.ok).toBe(true);
    expect(staged).toBe(false);
    if (result.ok) {
      expect(result.value.confirmation).toBe("not-requested");
      expect(result.value.confirmToken).toBe(commitPlanConfirmToken(result.value.advice));
      expect(result.value.confirmToken.startsWith("plan-commit-")).toBe(true);
    }
  });

  test("refuses a mismatched confirm token without mutating", async () => {
    const gitIdentity = identity();
    let staged = false;
    const git = fakeGit(
      async () => ({
        ok: true,
        value: {
          identity: gitIdentity,
          plan: planGitCommits({
            identity: gitIdentity,
            entries: [entry("src/foo.ts")],
            truncated: false,
            subjects: ["feat: ship"],
          }),
        },
      }),
      {
        stage: async () => {
          staged = true;
          return unused();
        },
      },
    );
    const result = await executeOutcomeCommitPlan(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
      confirmation: "plan-commit-deadbeefdead",
    });
    expect(result.ok).toBe(true);
    expect(staged).toBe(false);
    if (result.ok) {
      expect(result.value.confirmation).toBe("refused");
      expect(result.value.commits).toEqual([]);
    }
  });

  test("stages and commits each group when the confirm token matches", async () => {
    const gitIdentity = identity();
    const plan = planGitCommits({
      identity: gitIdentity,
      entries: [entry("src/foo.ts")],
      truncated: false,
      subjects: ["feat: ship"],
    });
    const planned = await planOutcomeCommits(
      fakeGit(async () => ({ ok: true, value: { identity: gitIdentity, plan } })),
      {
        outcomeId: "outcome-1",
        gitExecutable: "/usr/bin/git",
        startPath: "/repo",
      },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    const previewAdvice = planned.value;
    const token = commitPlanConfirmToken(previewAdvice);
    const stagedPaths: string[][] = [];
    const subjects: string[] = [];
    const git = fakeGit(async () => ({ ok: true, value: { identity: gitIdentity, plan } }), {
      stage: async (request) => {
        stagedPaths.push([...request.paths]);
        return {
          ok: true,
          value: { identity: gitIdentity, paths: request.paths },
        };
      },
      commit: async (request) => {
        subjects.push(request.subject);
        return {
          ok: true,
          value: {
            identity: {
              ...gitIdentity,
              head: {
                state: "observed" as const,
                value: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              },
            },
            oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            subject: request.subject,
          },
        };
      },
    });
    const result = await executeOutcomeCommitPlan(git, {
      outcomeId: "outcome-1",
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
      confirmation: token,
    });
    const [plannedGroup] = previewAdvice.plan.groups;
    expect(plannedGroup).toBeDefined();
    if (plannedGroup === undefined) {
      throw new Error("expected the preview plan to contain one commit group");
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.confirmation).toBe("applied");
      expect(stagedPaths).toEqual([[...plannedGroup.paths]]);
      expect(subjects).toEqual([plannedGroup.subject]);
      expect(result.value.commits).toHaveLength(1);
    }
  });
});
