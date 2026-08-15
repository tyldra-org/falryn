/**
 * Git observation contracts: validation and porcelain parsing.
 */

import { describe, expect, test } from "bun:test";

import { instant } from "./clock.ts";
import { localPath } from "./filesystem.ts";
import {
  classifyGitStderr,
  formatGitCheckpointMessage,
  GIT_INVOCATION_PREFIX,
  GIT_OBSERVATION_ENVIRONMENT,
  gitArgv,
  parseGitBlame,
  parseGitCheckpointMessage,
  parseGitCheckpointRefs,
  parseGitLog,
  parseGitRemotes,
  parseGitVersion,
  parseGitWorktrees,
  parseStatusPorcelainV2,
  redactGitRemoteUrl,
  refuseUnsafeGitIdentity,
  validateGitBlameRequest,
  validateGitIncludeUntracked,
  validateGitRefName,
  validateGitRelPath,
  validateGitRequest,
} from "./git.ts";

describe("git request validation", () => {
  test("refuses a relative git executable", () => {
    const parsed = validateGitRequest({
      gitExecutable: "git",
      startPath: "/tmp/repo",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toEqual({
        code: "invalid-request",
        reason: "git-executable-not-absolute",
      });
    }
  });

  test("refuses a relative start path", () => {
    const parsed = validateGitRequest({
      gitExecutable: "/usr/bin/git",
      startPath: "repo",
    });
    expect(parsed.ok).toBe(false);
  });

  test("refuses a blame path that looks like an option", () => {
    const parsed = validateGitBlameRequest("-n", undefined, undefined);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.code === "invalid-request") {
      expect(parsed.error.reason).toBe("blame-path");
    }
  });
});

describe("git argv", () => {
  test("prefixes every invocation so hooks cannot run", () => {
    expect(gitArgv(["status"])).toEqual([...GIT_INVOCATION_PREFIX, "status"]);
    expect(GIT_OBSERVATION_ENVIRONMENT.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("remote redaction", () => {
  test("strips embedded credentials from a remote URL", () => {
    expect(redactGitRemoteUrl("https://user:hunter2@github.com/org/repo.git")).toBe(
      "https://[redacted]@github.com/org/repo.git",
    );
  });
});

describe("stderr classification", () => {
  test("names dubious ownership separately from a missing repository", () => {
    expect(classifyGitStderr(128, "fatal: detected dubious ownership in repository")).toEqual({
      code: "unsafe-ownership",
    });
    expect(
      classifyGitStderr(
        128,
        "fatal: not a git repository (or any of the parent directories): .git",
      ),
    ).toEqual({
      code: "not-a-repository",
    });
    expect(
      classifyGitStderr(128, "fatal: Unable to create '/tmp/repo/.git/index.lock': File exists"),
    ).toEqual({
      code: "lock-contention",
    });
    expect(classifyGitStderr(128, "fatal: a branch named 'topic' already exists")).toEqual({
      code: "already-exists",
      reason: "name",
    });
    expect(classifyGitStderr(128, "fatal: 'main' is already checked out at '/tmp/repo'")).toEqual({
      code: "checked-out",
    });
    expect(
      classifyGitStderr(128, "fatal: 'main' is already used by worktree at '/tmp/repo'"),
    ).toEqual({
      code: "checked-out",
    });
    expect(classifyGitStderr(1, "error: the branch 'topic' is not fully merged.")).toEqual({
      code: "not-merged",
    });
    expect(classifyGitStderr(128, "fatal: Needed a single revision")).toEqual({
      code: "checkpoint-missing",
    });
    expect(
      classifyGitStderr(
        1,
        "error: Your local changes to the following files would be overwritten by checkout:",
      ),
    ).toEqual({ code: "dirty-worktree" });
  });
});

describe("porcelain parsing", () => {
  test("reads branch headers and ordinary entries from NUL-separated porcelain v2", () => {
    const stdout = [
      "# branch.oid abcdef1234567890abcdef1234567890abcdef12",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "1 .M N... 100644 100644 100644 abc def README.md",
      "? scratch.txt",
      "",
    ].join("\0");
    const parsed = parseStatusPorcelainV2(stdout, 256);
    expect(parsed.headState).toBe("branch");
    expect(parsed.branch).toEqual({ state: "observed", value: "main" });
    expect(parsed.ahead).toEqual({ state: "observed", value: 1 });
    expect(parsed.behind).toEqual({ state: "observed", value: 2 });
    expect(parsed.entries.state).toBe("observed");
    if (parsed.entries.state === "observed") {
      expect(parsed.entries.value).toEqual([
        {
          kind: "ordinary",
          path: "README.md",
          originalPath: null,
          indexStatus: ".",
          worktreeStatus: "M",
        },
        {
          kind: "untracked",
          path: "scratch.txt",
          originalPath: null,
          indexStatus: "?",
          worktreeStatus: "?",
        },
      ]);
    }
  });

  test("marks a detached unborn repository from branch headers", () => {
    const stdout = ["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0");
    const parsed = parseStatusPorcelainV2(stdout, 8);
    expect(parsed.headState).toBe("unborn");
    expect(parsed.head).toEqual({ state: "unavailable", reason: "unborn" });
    expect(parsed.branch).toEqual({ state: "unavailable", reason: "unborn" });
  });

  test("truncates status entries rather than dropping the snapshot", () => {
    const stdout = ["# branch.oid abc", "# branch.head main", "? a", "? b", "? c", ""].join("\0");
    const parsed = parseStatusPorcelainV2(stdout, 2);
    expect(parsed.entries.state).toBe("truncated");
    if (parsed.entries.state === "truncated") {
      expect(parsed.entries.value).toHaveLength(2);
      expect(parsed.entries.omitted).toBe(1);
    }
  });

  test("parses log records and blame lines", () => {
    const log = parseGitLog("abc\x1fabc123\x1fAda\x1fada@ex.com\x1f1700000000\x1fAdd file\n", 32);
    expect(log).toEqual({
      state: "observed",
      value: [
        {
          oid: "abc",
          shortOid: "abc123",
          authorName: "Ada",
          authorEmail: "ada@ex.com",
          authorAt: "1700000000",
          subject: "Add file",
        },
      ],
    });
    const blame = parseGitBlame(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1",
        "author Ada",
        "filename README.md",
        "\thello",
        "",
      ].join("\n"),
      32,
    );
    expect(blame.state).toBe("observed");
    if (blame.state === "observed") {
      expect(blame.value).toEqual([
        {
          oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          lineNumber: 1,
          path: "README.md",
          text: "hello",
        },
      ]);
    }
  });

  test("parses git version and redacts remotes", () => {
    expect(parseGitVersion("git version 2.47.0\n")).toEqual({ state: "observed", value: "2.47.0" });
    const remotes = parseGitRemotes(
      "origin\thttps://user:secret@example.com/repo.git (fetch)\norigin\thttps://user:secret@example.com/repo.git (push)\n",
    );
    expect(remotes.state).toBe("observed");
    if (remotes.state === "observed") {
      expect(remotes.value).toEqual([
        { name: "origin", url: "https://[redacted]@example.com/repo.git" },
      ]);
    }
  });
});

describe("git ref and worktree contracts", () => {
  test("refuses a ref name that looks like an option", () => {
    const parsed = validateGitRefName("-topic");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toEqual({ code: "invalid-request", reason: "ref-name" });
    }
  });

  test("refuses mutation while a merge is in progress", () => {
    const identity = {
      worktreeRoot: localPath("/work/project"),
      gitDir: ".git",
      commonDir: ".git",
      head: { state: "observed" as const, value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      headState: "branch" as const,
      branch: { state: "observed" as const, value: "main" },
      upstream: { state: "unavailable" as const, reason: "none" },
      ahead: { state: "unavailable" as const, reason: "none" },
      behind: { state: "unavailable" as const, reason: "none" },
      operation: "merge" as const,
      superproject: { state: "unavailable" as const, reason: "no-superproject" },
      sparseCheckout: { state: "observed" as const, value: false },
      gitVersion: { state: "observed" as const, value: "2.45.0" },
      remotes: { state: "observed" as const, value: [] },
      observedAt: instant(0),
    };
    expect(refuseUnsafeGitIdentity(identity, undefined)).toEqual({
      code: "operation-in-progress",
      operation: "merge",
    });
  });

  test("parses porcelain worktree records including detached and locked trees", () => {
    const stdout = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-detached",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "locked reason",
      "prunable gone",
      "",
      "",
    ].join("\0");
    const parsed = parseGitWorktrees(stdout, 8);
    expect(parsed.state).toBe("observed");
    if (parsed.state === "observed") {
      expect(parsed.value).toEqual([
        {
          path: "/repo",
          head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          branch: { state: "observed", value: "main" },
          detached: false,
          locked: false,
          prunable: false,
        },
        {
          path: "/repo-detached",
          head: { state: "observed", value: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
          branch: { state: "unavailable", reason: "detached" },
          detached: true,
          locked: true,
          prunable: true,
        },
      ]);
    }
  });
});

describe("checkpoint metadata", () => {
  const oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const payload = {
    head: oid,
    headState: "branch" as const,
    branch: "main",
    indexTree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    worktreeTree: "cccccccccccccccccccccccccccccccccccccccc",
    includedUntracked: [{ path: "scratch.txt", blob: "dddddddddddddddddddddddddddddddddddddddd" }],
    excludedUntracked: 2,
    truncated: false,
    sessionId: "session-1",
    turnId: null,
  };

  test("round-trips a checkpoint message", () => {
    const parsed = parseGitCheckpointMessage(oid, formatGitCheckpointMessage(payload));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ id: oid, ...payload });
    }
  });

  test("lists checkpoint oids and refuses a dotted include path", () => {
    const listed = parseGitCheckpointRefs(`${oid}\n${"b".repeat(40)}\n`, 8);
    expect(listed.state).toBe("observed");
    if (listed.state === "observed") {
      expect(listed.value).toEqual([oid, "b".repeat(40)]);
    }
    const path = validateGitRelPath("../secret");
    expect(path.ok).toBe(false);
    const included = validateGitIncludeUntracked(["scratch.txt", "scratch.txt"]);
    expect(included.ok).toBe(false);
  });
});
