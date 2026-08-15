/**
 * Git observation contracts: validation and porcelain parsing.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyGitStderr,
  GIT_INVOCATION_PREFIX,
  GIT_OBSERVATION_ENVIRONMENT,
  gitArgv,
  parseGitBlame,
  parseGitLog,
  parseGitRemotes,
  parseGitVersion,
  parseStatusPorcelainV2,
  redactGitRemoteUrl,
  validateGitBlameRequest,
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
