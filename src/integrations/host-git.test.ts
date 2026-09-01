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

async function cloneFrom(remote: string): Promise<string> {
  const parent = await scratch();
  const dest = join(parent, "repo");
  await runGitOk(parent, ["clone", remote, dest]);
  await runGitOk(dest, ["config", "user.name", "Falryn Test"]);
  await runGitOk(dest, ["config", "user.email", "test@example.com"]);
  await runGitOk(dest, ["config", "commit.gpgsign", "false"]);
  return dest;
}

async function repoWithOrigin(): Promise<{ root: string; remote: string }> {
  const remote = await scratch();
  await runGitOk(remote, ["init", "--bare", "-b", "main"]);
  const root = await committedRepo();
  await runGitOk(root, ["remote", "add", "origin", remote]);
  await runGitOk(root, ["push", "-u", "origin", "main"]);
  return { root, remote };
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

describe("host git branch and worktree mutations", () => {
  gitTest("creates switches and deletes a merged branch without force flags", async () => {
    const root = await committedRepo();
    const git = port();
    const created = await git.createBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "topic",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.kind).toBe("create-branch");
      expect(created.value.name).toBe("topic");
    }
    const switched = await git.switchBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "topic",
      timeoutMs: duration(5_000),
    });
    expect(switched.ok).toBe(true);
    if (switched.ok) {
      expect(switched.value.identity.branch).toEqual({ state: "observed", value: "topic" });
      expect(switched.value.previousRef).toBe("main");
    }
    const back = await git.switchBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "main",
      timeoutMs: duration(5_000),
    });
    expect(back.ok).toBe(true);
    const deleted = await git.deleteBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "topic",
      timeoutMs: duration(5_000),
    });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.currentRef).toBeNull();
    }
  });

  gitTest("refuses a dirty switch and an unmerged delete", async () => {
    const root = await committedRepo();
    await runGitOk(root, ["checkout", "-b", "topic"]);
    await writeFile(join(root, "README.md"), "topic\n", "utf8");
    await runGitOk(root, ["commit", "-am", "Topic"]);
    await runGitOk(root, ["checkout", "main"]);
    await writeFile(join(root, "README.md"), "dirty\n", "utf8");
    const git = port();
    const switched = await git.switchBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "topic",
      timeoutMs: duration(5_000),
    });
    expect(switched.ok).toBe(false);
    if (!switched.ok) {
      expect(switched.error.code).toBe("dirty-worktree");
    }
    await runGitOk(root, ["checkout", "--", "README.md"]);
    await runGitOk(root, ["checkout", "-b", "divergent"]);
    await writeFile(join(root, "README.md"), "divergent\n", "utf8");
    await runGitOk(root, ["commit", "-am", "Divergent"]);
    await runGitOk(root, ["checkout", "main"]);
    const deleted = await git.deleteBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "divergent",
      timeoutMs: duration(5_000),
    });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.error.code).toBe("not-merged");
    }
  });

  gitTest("adds lists and removes a clean linked worktree", async () => {
    const root = await committedRepo();
    const linked = await scratch();
    await rm(linked, { recursive: true, force: true });
    const git = port();
    const created = await git.createWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: linked,
      branch: "work",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.kind).toBe("create-worktree");
      expect(created.value.worktree?.branch).toEqual({ state: "observed", value: "work" });
    }
    const listed = await git.listWorktrees({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(listed.ok).toBe(true);
    if (listed.ok && listed.value.worktrees.state !== "unavailable") {
      expect(listed.value.worktrees.value.length).toBeGreaterThanOrEqual(2);
    }
    const removed = await git.removeWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: linked,
      timeoutMs: duration(5_000),
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.value.worktree).toBeNull();
    }
  });

  gitTest("refuses to remove a dirty worktree or the main worktree", async () => {
    const root = await committedRepo();
    const linked = await scratch();
    await rm(linked, { recursive: true, force: true });
    const git = port();
    const created = await git.createWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: linked,
      branch: "dirty-tree",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    await writeFile(join(linked, "scratch.txt"), "tmp\n", "utf8");
    const removed = await git.removeWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: linked,
      timeoutMs: duration(5_000),
    });
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error.code).toBe("dirty-worktree");
    }
    const main = await git.removeWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: root,
      timeoutMs: duration(5_000),
    });
    expect(main.ok).toBe(false);
    if (!main.ok) {
      expect(main.error.code).toBe("invalid-request");
    }
  });

  gitTest("refuses a second checkout of a branch already used by a worktree", async () => {
    const root = await committedRepo();
    const linked = await scratch();
    await rm(linked, { recursive: true, force: true });
    const git = port();
    const created = await git.createWorktree({
      gitExecutable: GIT,
      startPath: root,
      path: linked,
      startPoint: "main",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("checked-out");
    }
  });

  gitTest("refuses branch mutation during a merge", async () => {
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
    const created = await git.createBranch({
      gitExecutable: GIT,
      startPath: root,
      name: "after-merge",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("operation-in-progress");
    }
  });
});

describe("host git checkpoints and restore", () => {
  gitTest("creates lists and restores a dirty tracked worktree", async () => {
    const root = await committedRepo();
    const git = port();
    await writeFile(join(root, "README.md"), "dirty\n", "utf8");
    const created = await git.createCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      sessionId: "session-1",
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.checkpoint.sessionId).toBe("session-1");
    expect(created.value.checkpoint.excludedUntracked).toBe(0);
    await writeFile(join(root, "README.md"), "later\n", "utf8");
    const planned = await git.planRestore({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: created.value.checkpoint.id,
      timeoutMs: duration(5_000),
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.value.worktreePaths).toContain("README.md");
    }
    const restored = await git.restoreCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: created.value.checkpoint.id,
      timeoutMs: duration(5_000),
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.restoredWorktree).toContain("README.md");
    }
    expect(await Bun.file(join(root, "README.md")).text()).toBe("dirty\n");
    const listed = await git.listCheckpoints({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(listed.ok).toBe(true);
    if (listed.ok && listed.value.checkpoints.state !== "unavailable") {
      expect(
        listed.value.checkpoints.value.some((item) => item.id === created.value.checkpoint.id),
      ).toBe(true);
    }
  });

  gitTest("keeps unlisted untracked files out of restore", async () => {
    const root = await committedRepo();
    await writeFile(join(root, "scratch.txt"), "tmp\n", "utf8");
    await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
    const git = port();
    const created = await git.createCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      includeUntracked: ["keep.txt"],
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.value.checkpoint.excludedUntracked).toBe(1);
    expect(created.value.checkpoint.includedUntracked).toEqual([
      expect.objectContaining({ path: "keep.txt" }),
    ]);
    await rm(join(root, "keep.txt"));
    await writeFile(join(root, "scratch.txt"), "changed\n", "utf8");
    const restored = await git.restoreCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: created.value.checkpoint.id,
      timeoutMs: duration(5_000),
    });
    expect(restored.ok).toBe(true);
    expect(await Bun.file(join(root, "keep.txt")).text()).toBe("keep\n");
    expect(await Bun.file(join(root, "scratch.txt")).text()).toBe("changed\n");
  });

  gitTest("refuses an untracked collision and a moved HEAD", async () => {
    const root = await committedRepo();
    await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
    const git = port();
    const created = await git.createCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      includeUntracked: ["keep.txt"],
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await writeFile(join(root, "keep.txt"), "collision\n", "utf8");
    const collision = await git.planRestore({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: created.value.checkpoint.id,
      timeoutMs: duration(5_000),
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.error).toEqual({ code: "restore-ambiguous", reason: "untracked-collision" });
    }
    await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
    await writeFile(join(root, "README.md"), "moved\n", "utf8");
    await runGitOk(root, ["commit", "-am", "Move head"]);
    const moved = await git.planRestore({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: created.value.checkpoint.id,
      timeoutMs: duration(5_000),
    });
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.error).toEqual({ code: "restore-ambiguous", reason: "head-moved" });
    }
  });

  gitTest("refuses checkpoint create during a merge and cancelled restore", async () => {
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
    const created = await git.createCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("operation-in-progress");
    }
    const cancelled = await git.restoreCheckpoint({
      gitExecutable: GIT,
      startPath: root,
      checkpointId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timeoutMs: duration(5_000),
      signal: AbortSignal.abort(),
    });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.code).toBe("cancelled");
    }
  });
});

describe("host git commit planning", () => {
  gitTest("groups a source file with its test and does not mutate git", async () => {
    const root = await committedRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "foo.ts"), "export const foo = 1;\n", "utf8");
    await writeFile(join(root, "src", "foo.test.ts"), "test('foo', () => {});\n", "utf8");
    const git = port();
    const planned = await git.planCommits({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.value.plan.groups).toEqual([
      expect.objectContaining({
        paths: ["src/foo.ts", "src/foo.test.ts"],
        reason: "source-and-test",
      }),
    ]);
    expect(planned.value.plan.provenance.model).toBeNull();
    const status = await git.status({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(status.ok).toBe(true);
    if (status.ok && status.value.identity.head.state === "observed") {
      expect(status.value.identity.head.value).toBe(
        planned.value.identity.head.state === "observed" ? planned.value.identity.head.value : "",
      );
    }
    if (status.ok && status.value.entries.state !== "unavailable") {
      const paths = status.value.entries.value.map((entry) => entry.path);
      expect(paths).toContain("src/foo.ts");
      expect(paths).toContain("src/foo.test.ts");
      expect(status.value.entries.value.every((entry) => entry.kind === "untracked")).toBe(true);
    }
  });

  gitTest("leaves a secret path unassigned and refuses planning during a merge", async () => {
    const root = await committedRepo();
    await writeFile(join(root, ".env"), "TOKEN=1\n", "utf8");
    const git = port();
    const planned = await git.planCommits({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.value.plan.unassigned).toEqual([{ path: ".env", reason: "secret-path" }]);
    }
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
    const refused = await git.planCommits({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("operation-in-progress");
    }
  });

  gitTest("reports cancelled planning when the signal is already aborted", async () => {
    const root = await committedRepo();
    const git = port();
    const cancelled = await git.planCommits({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
      signal: AbortSignal.abort(),
    });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.code).toBe("cancelled");
    }
  });
});

describe("host git stage commit and sync", () => {
  gitTest("stages an explicit path, unstages it, and commits a subject", async () => {
    const root = await committedRepo();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "foo.ts"), "export const foo = 1;\n", "utf8");
    const git = port();
    const staged = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: ["src/foo.ts"],
      timeoutMs: duration(5_000),
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      return;
    }
    expect(staged.value.paths).toEqual(["src/foo.ts"]);
    const unstaged = await git.unstage({
      gitExecutable: GIT,
      startPath: root,
      paths: ["src/foo.ts"],
      timeoutMs: duration(5_000),
    });
    expect(unstaged.ok).toBe(true);
    const restaged = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: ["src/foo.ts"],
      timeoutMs: duration(5_000),
    });
    expect(restaged.ok).toBe(true);
    const committed = await git.commit({
      gitExecutable: GIT,
      startPath: root,
      subject: "feat: add foo",
      timeoutMs: duration(5_000),
    });
    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.value.subject).toBe("feat: add foo");
      expect(committed.value.oid).toHaveLength(40);
    }
  });

  gitTest("refuses secret paths, missing pathspecs, and an empty index", async () => {
    const root = await committedRepo();
    await writeFile(join(root, ".env"), "TOKEN=1\n", "utf8");
    const git = port();
    const secret = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: [".env"],
      timeoutMs: duration(5_000),
    });
    expect(secret.ok).toBe(false);
    if (!secret.ok) {
      expect(secret.error).toEqual({ code: "secret-path", path: ".env" });
    }
    const missing = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: [],
      timeoutMs: duration(5_000),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toEqual({ code: "invalid-request", reason: "paths" });
    }
    const empty = await git.commit({
      gitExecutable: GIT,
      startPath: root,
      subject: "feat: empty",
      timeoutMs: duration(5_000),
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("empty-index");
    }
    await runGitOk(root, ["add", "--", ".env"]);
    const unstaged = await git.unstage({
      gitExecutable: GIT,
      startPath: root,
      paths: [".env"],
      timeoutMs: duration(5_000),
    });
    expect(unstaged.ok).toBe(true);
    await runGitOk(root, ["add", "--", ".env"]);
    const blocked = await git.commit({
      gitExecutable: GIT,
      startPath: root,
      subject: "feat: secret",
      timeoutMs: duration(5_000),
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toEqual({ code: "secret-path", path: ".env" });
    }
  });

  gitTest("reports hook-failed when pre-commit exits non-zero", async () => {
    const root = await committedRepo();
    await writeFile(
      join(root, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho pre-commit hook failed >&2\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );
    await writeFile(join(root, "note.txt"), "note\n", "utf8");
    const git = port();
    const staged = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: ["note.txt"],
      timeoutMs: duration(5_000),
    });
    expect(staged.ok).toBe(true);
    const committed = await git.commit({
      gitExecutable: GIT,
      startPath: root,
      subject: "feat: note",
      timeoutMs: duration(5_000),
    });
    expect(committed.ok).toBe(false);
    if (!committed.ok) {
      expect(committed.error.code).toBe("hook-failed");
    }
  });

  gitTest(
    "fetches, fast-forward pulls, and pushes without force flags",
    async () => {
      const { remote } = await repoWithOrigin();
      const local = await cloneFrom(remote);
      const other = await cloneFrom(remote);
      const lagging = await cloneFrom(remote);
      await writeFile(join(other, "from-other.txt"), "other\n", "utf8");
      await runGitOk(other, ["add", "from-other.txt"]);
      await runGitOk(other, ["commit", "-m", "Add other"]);
      await runGitOk(other, ["push", "origin", "main"]);
      const git = port();
      const fastForward = await git.sync({
        gitExecutable: GIT,
        startPath: lagging,
        timeoutMs: duration(5_000),
      });
      expect(fastForward.ok).toBe(true);
      if (fastForward.ok) {
        expect(fastForward.value.fetched).toBe(true);
        expect(fastForward.value.fastForwarded).toBe(true);
        expect(fastForward.value.pushed).toBe(false);
      }
      const fetched = await git.fetch({
        gitExecutable: GIT,
        startPath: local,
        timeoutMs: duration(5_000),
      });
      expect(fetched.ok).toBe(true);
      if (fetched.ok) {
        expect(fetched.value.remote).toBe("origin");
        expect(
          fetched.value.identity.behind.state === "observed"
            ? fetched.value.identity.behind.value
            : 0,
        ).toBeGreaterThan(0);
      }
      const pulled = await git.pull({
        gitExecutable: GIT,
        startPath: local,
        timeoutMs: duration(5_000),
      });
      expect(pulled.ok).toBe(true);
      await writeFile(join(local, "from-local.txt"), "local\n", "utf8");
      const staged = await git.stage({
        gitExecutable: GIT,
        startPath: local,
        paths: ["from-local.txt"],
        timeoutMs: duration(5_000),
      });
      expect(staged.ok).toBe(true);
      const committed = await git.commit({
        gitExecutable: GIT,
        startPath: local,
        subject: "feat: local",
        timeoutMs: duration(5_000),
      });
      expect(committed.ok).toBe(true);
      const pushed = await git.push({
        gitExecutable: GIT,
        startPath: local,
        timeoutMs: duration(5_000),
      });
      expect(pushed.ok).toBe(true);
      await writeFile(join(local, "from-sync.txt"), "sync\n", "utf8");
      const restaged = await git.stage({
        gitExecutable: GIT,
        startPath: local,
        paths: ["from-sync.txt"],
        timeoutMs: duration(5_000),
      });
      expect(restaged.ok).toBe(true);
      const more = await git.commit({
        gitExecutable: GIT,
        startPath: local,
        subject: "feat: sync ahead",
        timeoutMs: duration(5_000),
      });
      expect(more.ok).toBe(true);
      const published = await git.sync({
        gitExecutable: GIT,
        startPath: local,
        timeoutMs: duration(5_000),
      });
      expect(published.ok).toBe(true);
      if (published.ok) {
        expect(published.value.fetched).toBe(true);
        expect(published.value.fastForwarded).toBe(false);
        expect(published.value.pushed).toBe(true);
      }
      const synced = await git.sync({
        gitExecutable: GIT,
        startPath: local,
        timeoutMs: duration(5_000),
      });
      expect(synced.ok).toBe(true);
      if (synced.ok) {
        expect(synced.value.fetched).toBe(true);
        expect(synced.value.fastForwarded).toBe(false);
        expect(synced.value.pushed).toBe(false);
      }
    },
    15_000,
  );

  gitTest("refuses a dirty pull, a missing upstream, and a diverged sync", async () => {
    const { root, remote } = await repoWithOrigin();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");
    const git = port();
    const dirty = await git.pull({
      gitExecutable: GIT,
      startPath: root,
      timeoutMs: duration(5_000),
    });
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) {
      expect(dirty.error.code).toBe("dirty-worktree");
    }
    const isolated = await committedRepo();
    const missing = await git.pull({
      gitExecutable: GIT,
      startPath: isolated,
      timeoutMs: duration(5_000),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("no-upstream");
    }
    const left = await cloneFrom(remote);
    const right = await cloneFrom(remote);
    await writeFile(join(left, "left.txt"), "left\n", "utf8");
    await runGitOk(left, ["add", "left.txt"]);
    await runGitOk(left, ["commit", "-m", "Add left"]);
    await runGitOk(left, ["push", "origin", "main"]);
    await writeFile(join(right, "right.txt"), "right\n", "utf8");
    await runGitOk(right, ["add", "right.txt"]);
    await runGitOk(right, ["commit", "-m", "Add right"]);
    const diverged = await git.sync({
      gitExecutable: GIT,
      startPath: right,
      timeoutMs: duration(5_000),
    });
    expect(diverged.ok).toBe(false);
    if (!diverged.ok) {
      expect(diverged.error.code).toBe("diverged");
    }
  });

  gitTest("refuses mutation during a merge and cancelled stage", async () => {
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
    await writeFile(join(root, "extra.txt"), "extra\n", "utf8");
    const git = port();
    const refused = await git.stage({
      gitExecutable: GIT,
      startPath: root,
      paths: ["extra.txt"],
      timeoutMs: duration(5_000),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("operation-in-progress");
    }
    const clean = await committedRepo();
    await writeFile(join(clean, "extra.txt"), "extra\n", "utf8");
    const cancelled = await git.stage({
      gitExecutable: GIT,
      startPath: clean,
      paths: ["extra.txt"],
      timeoutMs: duration(5_000),
      signal: AbortSignal.abort(),
    });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.code).toBe("cancelled");
    }
  });
});
