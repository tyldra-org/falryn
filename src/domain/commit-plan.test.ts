import { describe, expect, test } from "bun:test";
import { instant } from "./clock.ts";
import { isSecretPath, planGitCommits } from "./commit-plan.ts";
import { localPath } from "./filesystem.ts";
import type { GitIdentity, GitStatusEntry } from "./git.ts";

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

describe("commit planning", () => {
  test("pairs a source file with its test and drafts a conventional subject", () => {
    const plan = planGitCommits({
      identity: identity(),
      entries: [entry("src/foo.ts"), entry("src/foo.test.ts")],
      truncated: false,
      subjects: ["feat(runtime): add checkpoints and restore plans"],
    });
    expect(plan.groups).toEqual([
      {
        id: "group-1",
        paths: ["src/foo.ts", "src/foo.test.ts"],
        reason: "source-and-test",
        subject: "feat(src): update foo",
      },
    ]);
    expect(plan.provenance).toEqual({
      version: 1,
      source: "git-status-log",
      model: null,
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      truncated: false,
    });
    expect(plan.validation.groupCount).toBe(1);
    expect(plan.validation.unassignedCount).toBe(0);
  });

  test("pairs package.json with a lockfile and orders it before source", () => {
    const plan = planGitCommits({
      identity: identity(),
      entries: [entry("src/foo.ts"), entry("package.json"), entry("bun.lock")],
      truncated: false,
      subjects: [],
    });
    expect(plan.groups.map((group) => group.reason)).toEqual([
      "package-and-lockfile",
      "single-change",
    ]);
    expect(plan.groups[0]?.subject).toBe("build: update package lockfile");
  });

  test("groups remaining files in the same directory", () => {
    const plan = planGitCommits({
      identity: identity(),
      entries: [entry("guides/a.md"), entry("guides/b.md")],
      truncated: false,
      subjects: ["docs(tools): record #79 checkpoints and restore"],
    });
    expect(plan.groups).toEqual([
      {
        id: "group-1",
        paths: ["guides/a.md", "guides/b.md"],
        reason: "same-directory",
        subject: "docs(guides): update guides",
      },
    ]);
  });

  test("leaves conflicts and secret paths unassigned and omits ignored files", () => {
    const plan = planGitCommits({
      identity: identity(),
      entries: [
        entry("src/foo.ts"),
        entry("src/conflict.ts", "unmerged", "U", "U"),
        entry(".env", "untracked", "?", "?"),
        entry("scratch.log", "ignored", "!", "!"),
      ],
      truncated: false,
      subjects: [],
    });
    expect(plan.inventory.map((unit) => unit.path)).toEqual([
      "src/foo.ts",
      "src/conflict.ts",
      ".env",
    ]);
    expect(plan.unassigned).toEqual([
      { path: "src/conflict.ts", reason: "conflict" },
      { path: ".env", reason: "secret-path" },
    ]);
    expect(plan.validation).toEqual({
      groupCount: 1,
      unassignedCount: 2,
      conflictCount: 1,
      secretPathCount: 1,
      truncated: false,
      detached: false,
    });
  });

  test("returns an empty plan for a clean tree and flags detached HEAD", () => {
    const plan = planGitCommits({
      identity: identity("detached"),
      entries: [],
      truncated: false,
      subjects: ["WIP snapshot"],
    });
    expect(plan.groups).toEqual([]);
    expect(plan.validation.detached).toBe(true);
    expect(plan.provenance.model).toBeNull();
  });

  test("recognizes secret-looking paths without grouping them", () => {
    expect(isSecretPath(".env.local")).toBe(true);
    expect(isSecretPath("secrets/token")).toBe(true);
    expect(isSecretPath("id_rsa")).toBe(true);
    expect(isSecretPath("credentials.json")).toBe(true);
    expect(isSecretPath("tls.pem")).toBe(true);
    expect(isSecretPath("src/foo.ts")).toBe(false);
  });

  test("drafts an imperative subject when recent history is not conventional", () => {
    const plan = planGitCommits({
      identity: identity(),
      entries: [entry("src/foo.ts")],
      truncated: false,
      subjects: ["WIP snapshot", "more work"],
    });
    expect(plan.groups[0]?.subject).toBe("update foo");
  });

  test("unassigns overflow groups when the plan exceeds the group cap", () => {
    const entries = Array.from({ length: 17 }, (_, index) =>
      entry(`file-${String(index).padStart(2, "0")}.ts`),
    );
    const plan = planGitCommits({
      identity: identity(),
      entries,
      truncated: false,
      subjects: [],
    });
    expect(plan.validation.groupCount).toBe(16);
    expect(plan.unassigned).toEqual([{ path: "file-16.ts", reason: "truncated" }]);
    expect(plan.validation.truncated).toBe(true);
  });
});
