/**
 * Product Git tools (#713).
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  type GitPort,
  instant,
  invocationId,
  localPath,
  ok,
} from "../domain/index.ts";
import { composeProductGitTools } from "./product-tools-git.ts";

function unused(): never {
  throw new Error("unexpected GitPort call");
}

function identity(startPath: string) {
  return {
    worktreeRoot: localPath(startPath),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed" as const, value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    headState: "branch" as const,
    branch: { state: "observed" as const, value: "main" },
    upstream: { state: "unavailable" as const, reason: "none" as const },
    ahead: { state: "unavailable" as const, reason: "none" as const },
    behind: { state: "unavailable" as const, reason: "none" as const },
    operation: "clean" as const,
    superproject: { state: "unavailable" as const, reason: "no-superproject" as const },
    sparseCheckout: { state: "observed" as const, value: false },
    gitVersion: { state: "observed" as const, value: "2.45.0" },
    remotes: { state: "observed" as const, value: [] },
    observedAt: instant(0),
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

describe("composeProductGitTools", () => {
  test("registers Git tools and routes status through GitPort", async () => {
    const tools = composeProductGitTools({
      generation: configurationGeneration.from(0),
      gitExecutable: "/usr/bin/git",
      startPath: "/repo",
      git: fakeGit({
        status: async (request) =>
          ok({
            identity: identity(request.startPath),
            entries: { state: "observed", value: [] },
          }),
        stage: async (request) =>
          ok({
            identity: identity(request.startPath),
            paths: request.paths,
          }),
      }),
    });

    expect(tools.owner).toBe("#713");
    expect(tools.toolNames).toContain("git_status");
    expect(tools.toolNames).toContain("git_commit");
    expect(tools.catalog.resolve("git_status")?.effect).toBe("observation");
    expect(tools.catalog.resolve("git_stage")?.effect).toBe("mutation");

    const status = await tools.runner.execute({
      invocationId: invocationId.from("inv-status"),
      toolCallId: "call-status",
      toolName: "git_status",
      capabilityId: capabilityId.from("builtin:workspace/git_status@1"),
      version: 1,
      effect: "observation",
      input: {},
      signal: new AbortController().signal,
    });
    expect(status.status).toBe("completed");

    const staged = await tools.runner.execute({
      invocationId: invocationId.from("inv-stage"),
      toolCallId: "call-stage",
      toolName: "git_stage",
      capabilityId: capabilityId.from("builtin:workspace/git_stage@1"),
      version: 1,
      effect: "mutation",
      input: { paths: ["a.ts"] },
      signal: new AbortController().signal,
    });
    expect(staged.status).toBe("completed");
  });
});
