/**
 * Host Git observation against disposable repositories.
 *
 * Setup may spawn git directly. The port under test still goes through
 * ProcessCapturePort with a supplied environment and structured argv.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { duration } from "../domain/index.ts";
import { createHostGitPort } from "./host-git.ts";
import { createHostProcessCapturePort } from "./host-process-capture.ts";

const locatedGit = Bun.which("git");
const GIT = locatedGit ?? "/usr/bin/git";
const gitTest = locatedGit === null ? test.skip : test;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "falryn-git-"));
  roots.push(root);
  return root;
}

const GIT_FIXTURE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Falryn Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Falryn Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function runGit(cwd: string, args: readonly string[]): Promise<number> {
  if (locatedGit === null) {
    throw new Error("git is required for this fixture");
  }
  const child = Bun.spawn([GIT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_FIXTURE_ENV,
  });
  return await child.exited;
}

async function runGitOk(cwd: string, args: readonly string[]): Promise<void> {
  if (locatedGit === null) {
    throw new Error("git is required for this fixture");
  }
  const child = Bun.spawn([GIT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_FIXTURE_ENV,
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function committedRepo(): Promise<string> {
  const root = await scratch();
  await runGitOk(root, ["init", "-b", "main"]);
  await runGitOk(root, ["config", "user.name", "Falryn Test"]);
  await runGitOk(root, ["config", "user.email", "test@example.com"]);
  await runGitOk(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await runGitOk(root, ["add", "README.md"]);
  await runGitOk(root, ["commit", "-m", "Add readme"]);
  return root;
}

function port() {
  return createHostGitPort({ capture: createHostProcessCapturePort() });
}

describe("host git observation", () => {
  gitTest("discovers a repository from a nested start path", async () => {
    const root = await committedRepo();
    await mkdir(join(root, "src"));
    const git = port();
    const discovered = await git.discover({
      gitExecutable: GIT,
      startPath: join(root, "src"),
      timeoutMs: duration(5_000),
    });
    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(await realpath(discovered.value.worktreeRoot)).toBe(await realpath(root));
      expect(discovered.value.headState).toBe("branch");
      expect(discovered.value.branch).toEqual({ state: "observed", value: "main" });
      expect(discovered.value.operation).toBe("clean");
      expect(discovered.value.gitVersion.state).toBe("observed");
    }
  });

  gitTest("reports not-a-repository for an ordinary directory", async () => {
    const root = await scratch();
    const git = port();
    const discovered = await git.discover({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.error.code).toBe("not-a-repository");
    }
  });

  gitTest("status names dirty, untracked, and ignored paths", async () => {
    const root = await committedRepo();
    await writeFile(join(root, "README.md"), "hello world\n", "utf8");
    await writeFile(join(root, "scratch.txt"), "tmp\n", "utf8");
    await writeFile(join(root, ".gitignore"), "secret.log\n", "utf8");
    await writeFile(join(root, "secret.log"), "token\n", "utf8");
    const git = port();
    const status = await git.status({
      gitExecutable: GIT,
      startPath: root,
      includeIgnored: true,
      timeoutMs: duration(5_000),
    });
    expect(status.ok).toBe(true);
    if (status.ok && status.value.entries.state !== "unavailable") {
      const paths = status.value.entries.value.map((entry) => entry.path);
      expect(paths).toContain("README.md");
      expect(paths).toContain("scratch.txt");
      expect(paths).toContain("secret.log");
      expect(paths).toContain(".gitignore");
    }
  });

  gitTest("status sees a conflict as unmerged", async () => {
    const root = await committedRepo();
    await runGitOk(root, ["checkout", "-b", "other"]);
    await writeFile(join(root, "README.md"), "other\n", "utf8");
    await runGitOk(root, ["commit", "-am", "Other"]);
    await runGitOk(root, ["checkout", "main"]);
    await writeFile(join(root, "README.md"), "mainline\n", "utf8");
    await runGitOk(root, ["commit", "-am", "Mainline"]);
    const mergeCode = await runGit(root, [
      "-c",
      "merge.ff=false",
      "merge",
      "--no-ff",
      "--no-commit",
      "other",
    ]);
    expect(mergeCode).not.toBe(0);
    const git = port();
    const status = await git.status({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.identity.operation).toBe("merge");
      if (status.value.entries.state !== "unavailable") {
        expect(status.value.entries.value.some((entry) => entry.kind === "unmerged")).toBe(true);
      }
    }
  });

  gitTest("diff and log observe a committed change", async () => {
    const root = await committedRepo();
    await writeFile(join(root, "README.md"), "hello world\n", "utf8");
    const git = port();
    const diff = await git.diff({
      gitExecutable: GIT,
      startPath: root,
      scope: "head",
      timeoutMs: duration(5_000),
    });
    expect(diff.ok).toBe(true);
    if (diff.ok && diff.value.text.state !== "unavailable") {
      expect(diff.value.text.value).toContain("hello world");
    }
    const log = await git.log({
      gitExecutable: GIT,
      startPath: root,
      maxCount: 8,
      timeoutMs: duration(5_000),
    });
    expect(log.ok).toBe(true);
    if (log.ok && log.value.commits.state !== "unavailable") {
      expect(log.value.commits.value[0]?.subject).toBe("Add readme");
    }
  });

  gitTest("blame attributes a committed line", async () => {
    const root = await committedRepo();
    const git = port();
    const blame = await git.blame({
      gitExecutable: GIT,
      startPath: root,
      path: "README.md",
      timeoutMs: duration(5_000),
    });
    expect(blame.ok).toBe(true);
    if (blame.ok && blame.value.lines.state !== "unavailable") {
      expect(blame.value.lines.value[0]?.text).toBe("hello");
      expect(blame.value.lines.value[0]?.oid.length).toBe(40);
    }
  });

  gitTest("an already-aborted request starts no git process", async () => {
    const root = await committedRepo();
    const git = port();
    const signal = AbortSignal.abort();
    const discovered = await git.discover({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
      signal,
    });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.error.code).toBe("cancelled");
    }
  });

  gitTest("a nested repository is discovered from its own root", async () => {
    const outer = await committedRepo();
    const inner = join(outer, "vendor", "lib");
    await mkdir(inner, { recursive: true });
    await runGitOk(inner, ["init", "-b", "vendored"]);
    await writeFile(join(inner, "lib.txt"), "nested\n", "utf8");
    await runGitOk(inner, ["add", "lib.txt"]);
    await runGitOk(inner, ["commit", "-m", "Vendored"]);
    const git = port();
    const discovered = await git.discover({
      gitExecutable: GIT,
      startPath: inner,
      timeoutMs: duration(5_000),
    });
    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(await realpath(discovered.value.worktreeRoot)).toBe(await realpath(inner));
      expect(discovered.value.branch).toEqual({ state: "observed", value: "vendored" });
    }
  });

  gitTest("redacts credentials in observed remotes", async () => {
    const root = await committedRepo();
    await runGitOk(root, ["remote", "add", "origin", "https://user:hunter2@example.com/repo.git"]);
    const git = port();
    const discovered = await git.discover({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(discovered.ok).toBe(true);
    if (discovered.ok && discovered.value.remotes.state === "observed") {
      expect(discovered.value.remotes.value[0]?.url).toBe(
        "https://[redacted]@example.com/repo.git",
      );
      expect(discovered.value.remotes.value[0]?.url.includes("hunter2")).toBe(false);
    }
  });
});
