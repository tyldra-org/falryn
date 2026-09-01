/**
 * Shared mutation preparation, checkpoint, worktree, and observation helpers
 * for the host Git adapter.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  type DurationMs,
  formatGitCheckpointMessage,
  type GitCheckpointRecord,
  type GitDiffScope,
  type GitError,
  type GitField,
  type GitIdentity,
  type GitOperationState,
  type GitRemote,
  type GitRestoreCheckpointRequest,
  type GitRestorePlan,
  type GitStatusEntry,
  type GitStatusSnapshot,
  type GitWorktreeRecord,
  gitCheckpointRef,
  type LocalPath,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_GIT_WORKTREES,
  type ProcessCaptureReport,
  parseGitCheckpointMessage,
  parseGitRemotes,
  parseGitWorktrees,
  parseStatusPorcelainV2,
  refuseUnsafeGitIdentity,
  validateGitOid,
  validateGitRequest,
} from "../../domain/index.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { GitRunner } from "./contracts.ts";

export function diffArgv(scope: GitDiffScope, path: string | undefined): readonly string[] {
  const pathArgs = path === undefined ? [] : ["--", path];
  switch (scope) {
    case "worktree":
      return ["diff", "--no-color", "--no-ext-diff", ...pathArgs];
    case "index":
      return ["diff", "--no-color", "--no-ext-diff", "--cached", ...pathArgs];
    case "head":
      return ["diff", "--no-color", "--no-ext-diff", "HEAD", ...pathArgs];
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

export function captureErrorToGit(code: string): GitError {
  switch (code) {
    case "invalid-executable":
      return { code: "spawn-failed", reason: code };
    case "cancelled":
      return { code: "cancelled" };
    default:
      if (code.startsWith("invalid-") || code.includes("too-")) {
        return { code: "invalid-request", reason: code };
      }
      return { code: "failed", reason: code };
  }
}

type IdentityLoader = (
  gitExecutable: string,
  startPath: string,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
) => Promise<Result<GitIdentity, GitError>>;

type PreparedMutation = {
  readonly gitExecutable: string;
  readonly startPath: string;
  readonly timeoutMs: DurationMs;
  readonly signal: AbortSignal | undefined;
  readonly identity: GitIdentity;
  readonly loadIdentity: IdentityLoader;
};

export async function prepareMutation(
  request: {
    readonly gitExecutable: string;
    readonly startPath: string;
    readonly timeoutMs?: DurationMs | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly expectedHead?: string | undefined;
  },
  loadIdentity: IdentityLoader,
): Promise<Result<PreparedMutation, GitError>> {
  const parsed = validateGitRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const identity = await loadIdentity(
    parsed.value.gitExecutable,
    parsed.value.startPath,
    parsed.value.timeoutMs,
    parsed.value.signal,
  );
  if (!identity.ok) {
    return identity;
  }
  const refused = refuseUnsafeGitIdentity(identity.value, request.expectedHead);
  if (refused !== null) {
    return err(refused);
  }
  return ok({
    gitExecutable: parsed.value.gitExecutable,
    startPath: parsed.value.startPath,
    timeoutMs: parsed.value.timeoutMs,
    signal: parsed.value.signal,
    identity: identity.value,
    loadIdentity,
  });
}

export async function reloadIdentity(
  prepared: PreparedMutation,
): Promise<Result<GitIdentity, GitError>> {
  return prepared.loadIdentity(
    prepared.gitExecutable,
    prepared.startPath,
    prepared.timeoutMs,
    prepared.signal,
  );
}

export async function snapshotCheckpoint(
  mutation: PreparedMutation,
  includeUntracked: readonly string[],
  sessionId: string | null,
  turnId: string | null,
  runGit: GitRunner,
): Promise<Result<GitCheckpointRecord, GitError>> {
  const head = mutation.identity.head;
  if (head.state !== "observed") {
    return err({ code: "invalid-request", reason: "unborn" });
  }
  const indexTree = await readOid(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["write-tree"],
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!indexTree.ok) {
    return indexTree;
  }
  const status = await statusAt(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!status.ok) {
    return status;
  }
  if (status.value.state === "unavailable") {
    return err({ code: "failed", reason: "status-unavailable" });
  }
  const worktreeTree = await snapshotWorktreeTree(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    mutation.identity.gitDir,
    indexTree.value,
    status.value.value,
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!worktreeTree.ok) {
    return worktreeTree;
  }
  const truncated = status.value.state === "truncated";
  const untracked = new Set(
    status.value.value.filter((entry) => entry.kind === "untracked").map((entry) => entry.path),
  );
  const included: GitCheckpointRecord["includedUntracked"][number][] = [];
  for (const path of includeUntracked) {
    if (!untracked.has(path)) {
      return err({ code: "invalid-request", reason: "include-untracked" });
    }
    const blob = await readOid(
      mutation.gitExecutable,
      mutation.identity.worktreeRoot,
      ["hash-object", "-w", "--", path],
      mutation.timeoutMs,
      mutation.signal,
      runGit,
    );
    if (!blob.ok) {
      return blob;
    }
    included.push({ path, blob: blob.value });
  }
  const payload = {
    head: head.value,
    headState: mutation.identity.headState,
    branch: mutation.identity.branch.state === "observed" ? mutation.identity.branch.value : null,
    indexTree: indexTree.value,
    worktreeTree: worktreeTree.value,
    includedUntracked: included,
    excludedUntracked: Math.max(0, untracked.size - included.length),
    truncated,
    sessionId,
    turnId,
  };
  const indexCommit = await readOid(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["commit-tree", payload.indexTree, "-p", head.value, "-m", "falryn-checkpoint-index"],
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!indexCommit.ok) {
    return indexCommit;
  }
  const committed = await readOid(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    [
      "commit-tree",
      payload.worktreeTree,
      "-p",
      indexCommit.value,
      "-m",
      formatGitCheckpointMessage(payload),
    ],
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!committed.ok) {
    return committed;
  }
  const stored = await runGit(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["update-ref", gitCheckpointRef(committed.value), committed.value],
    mutation.timeoutMs,
    mutation.signal,
    4_096,
  );
  if (!stored.ok) {
    return stored;
  }
  return ok({ id: committed.value, ...payload });
}

async function snapshotWorktreeTree(
  gitExecutable: string,
  cwd: string,
  gitDir: string,
  indexTree: string,
  entries: readonly GitStatusEntry[],
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
): Promise<Result<string, GitError>> {
  const scratch = await mkdtemp(join(tmpdir(), "falryn-git-worktree-"));
  const extraEnv = gitIndexEnv(cwd, gitDir, join(scratch, "index"));
  try {
    const loaded = await runGit(
      gitExecutable,
      cwd,
      ["read-tree", indexTree],
      timeoutMs,
      signal,
      4_096,
      extraEnv,
    );
    if (!loaded.ok) {
      return loaded;
    }
    for (const entry of entries) {
      if (entry.kind !== "ordinary" && entry.kind !== "rename") {
        continue;
      }
      if (entry.worktreeStatus === "." || entry.worktreeStatus === " ") {
        continue;
      }
      if (entry.worktreeStatus === "D") {
        const removed = await runGit(
          gitExecutable,
          cwd,
          ["update-index", "--remove", "--", entry.path],
          timeoutMs,
          signal,
          4_096,
          extraEnv,
        );
        if (!removed.ok) {
          return removed;
        }
        continue;
      }
      const blob = await readOid(
        gitExecutable,
        cwd,
        ["hash-object", "-w", "--", entry.path],
        timeoutMs,
        signal,
        runGit,
      );
      if (!blob.ok) {
        return blob;
      }
      const cached = await runGit(
        gitExecutable,
        cwd,
        ["update-index", "--cacheinfo", "100644", blob.value, entry.path],
        timeoutMs,
        signal,
        4_096,
        extraEnv,
      );
      if (!cached.ok) {
        return cached;
      }
    }
    return await readOid(gitExecutable, cwd, ["write-tree"], timeoutMs, signal, runGit, extraEnv);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function loadCheckpointRecord(
  gitExecutable: string,
  cwd: string,
  id: string,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
): Promise<Result<GitCheckpointRecord, GitError>> {
  const message = await runGit(
    gitExecutable,
    cwd,
    ["log", "-n", "1", "--format=%B", id],
    timeoutMs,
    signal,
    MAX_COMMAND_OUTPUT_BYTES,
  );
  if (!message.ok) {
    return message;
  }
  return parseGitCheckpointMessage(id, message.value.stdout.inlineText ?? "");
}

export async function buildRestorePlan(
  request: GitRestoreCheckpointRequest,
  loadIdentity: IdentityLoader,
  runGit: GitRunner,
  probeGit: GitRunner,
): Promise<Result<GitRestorePlan, GitError>> {
  const prepared = await prepareMutation(request, loadIdentity);
  if (!prepared.ok) {
    return prepared;
  }
  const mutation = prepared.value;
  const checkpointId = validateGitOid(request.checkpointId);
  if (!checkpointId.ok) {
    return checkpointId;
  }
  const resolved = await readOid(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["rev-parse", "--verify", checkpointId.value],
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!resolved.ok) {
    return resolved.error.code === "not-a-repository"
      ? err({ code: "checkpoint-missing" })
      : resolved;
  }
  const checkpoint = await loadCheckpointRecord(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    resolved.value,
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!checkpoint.ok) {
    return checkpoint;
  }
  if (checkpoint.value.truncated) {
    return err({ code: "restore-ambiguous", reason: "truncated" });
  }
  if (
    mutation.identity.head.state !== "observed" ||
    mutation.identity.head.value !== checkpoint.value.head
  ) {
    return err({ code: "restore-ambiguous", reason: "head-moved" });
  }
  const currentIndex = await readOid(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["write-tree"],
    mutation.timeoutMs,
    mutation.signal,
    runGit,
  );
  if (!currentIndex.ok) {
    return currentIndex;
  }
  const worktreeDiff = await runGit(
    mutation.gitExecutable,
    mutation.identity.worktreeRoot,
    ["diff", "--name-only", "--no-color", checkpoint.value.worktreeTree],
    mutation.timeoutMs,
    mutation.signal,
    MAX_COMMAND_OUTPUT_BYTES,
  );
  if (!worktreeDiff.ok) {
    return worktreeDiff;
  }
  const worktreePaths = (worktreeDiff.value.stdout.inlineText ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  const untrackedRestores: string[] = [];
  for (const entry of checkpoint.value.includedUntracked) {
    const hashed = await probeGit(
      mutation.gitExecutable,
      mutation.identity.worktreeRoot,
      ["hash-object", "--", entry.path],
      mutation.timeoutMs,
      mutation.signal,
      256,
    );
    if (!hashed.ok) {
      return hashed;
    }
    if ((hashed.value.exit.exitCode ?? 1) !== 0) {
      untrackedRestores.push(entry.path);
      continue;
    }
    const blob = stdoutOid(hashed.value);
    if (!blob.ok) {
      return blob;
    }
    if (blob.value !== entry.blob) {
      return err({ code: "restore-ambiguous", reason: "untracked-collision" });
    }
  }
  return ok({
    identity: mutation.identity,
    checkpoint: checkpoint.value,
    indexChanged: currentIndex.value !== checkpoint.value.indexTree,
    worktreePaths,
    untrackedRestores,
  });
}

export async function restoreUntrackedBlob(
  gitExecutable: string,
  cwd: string,
  gitDir: string,
  path: string,
  blob: string,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
): Promise<Result<void, GitError>> {
  const scratch = await mkdtemp(join(tmpdir(), "falryn-git-untracked-"));
  const extraEnv = gitIndexEnv(cwd, gitDir, join(scratch, "index"));
  try {
    const emptied = await runGit(
      gitExecutable,
      cwd,
      ["read-tree", "--empty"],
      timeoutMs,
      signal,
      4_096,
      extraEnv,
    );
    if (!emptied.ok) {
      return emptied;
    }
    const cached = await runGit(
      gitExecutable,
      cwd,
      ["update-index", "--add", "--cacheinfo", "100644", blob, path],
      timeoutMs,
      signal,
      4_096,
      extraEnv,
    );
    if (!cached.ok) {
      return cached;
    }
    const checked = await runGit(
      gitExecutable,
      cwd,
      ["checkout-index", "--", path],
      timeoutMs,
      signal,
      4_096,
      extraEnv,
    );
    if (!checked.ok) {
      return checked;
    }
    return ok(undefined);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readOid(
  gitExecutable: string,
  cwd: string,
  subcommand: readonly string[],
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
  extraEnv?: Readonly<Record<string, string>> | undefined,
): Promise<Result<string, GitError>> {
  const report = await runGit(gitExecutable, cwd, subcommand, timeoutMs, signal, 256, extraEnv);
  if (!report.ok) {
    return report;
  }
  return stdoutOid(report.value);
}

function stdoutOid(report: ProcessCaptureReport): Result<string, GitError> {
  const oid = report.stdout.inlineText?.trim() ?? "";
  return validateGitOid(oid.length === 40 ? oid : oid.slice(0, 40));
}

function gitIndexEnv(
  worktreeRoot: string,
  gitDir: string,
  indexFile: string,
): Readonly<Record<string, string>> {
  return {
    GIT_INDEX_FILE: indexFile,
    GIT_DIR: isAbsolute(gitDir) ? gitDir : join(worktreeRoot, gitDir),
    GIT_WORK_TREE: worktreeRoot,
  };
}

export async function listWorktreeAt(
  gitExecutable: string,
  cwd: string,
  path: string,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
): Promise<Result<GitWorktreeRecord, GitError>> {
  const report = await runGit(
    gitExecutable,
    cwd,
    ["worktree", "list", "--porcelain", "-z"],
    timeoutMs,
    signal,
    MAX_COMMAND_OUTPUT_BYTES,
  );
  if (!report.ok) {
    return report;
  }
  const listed = parseGitWorktrees(report.value.stdout.inlineText ?? "", MAX_GIT_WORKTREES);
  if (listed.state === "unavailable") {
    return err({ code: "failed", reason: "worktrees-unavailable" });
  }
  const found = listed.value.find((worktree) => sameWorktreePath(worktree.path, path));
  if (found === undefined) {
    return err({ code: "failed", reason: "worktree-missing" });
  }
  return ok(found);
}

export async function statusAt(
  gitExecutable: string,
  cwd: string,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  runGit: GitRunner,
): Promise<Result<GitStatusSnapshot["entries"], GitError>> {
  const report = await runGit(
    gitExecutable,
    cwd,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    timeoutMs,
    signal,
    MAX_COMMAND_OUTPUT_BYTES,
  );
  if (!report.ok) {
    return report;
  }
  return ok(parseStatusPorcelainV2(report.value.stdout.inlineText ?? "", 1_024).entries);
}

export function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\/+$/, "").replace(/^\/private\//, "/");
  return normalize(left) === normalize(right);
}

export function remoteField(
  report: Result<ProcessCaptureReport, GitError>,
): GitField<readonly GitRemote[]> {
  if (!report.ok) {
    return { state: "unavailable", reason: report.error.code };
  }
  if ((report.value.exit.exitCode ?? 1) !== 0) {
    return { state: "unavailable", reason: "remote-unavailable" };
  }
  return parseGitRemotes(report.value.stdout.inlineText ?? "");
}

export function sparseField(report: Result<ProcessCaptureReport, GitError>): GitField<boolean> {
  if (!report.ok) {
    return { state: "observed", value: false };
  }
  return { state: "observed", value: report.value.stdout.inlineText?.trim() === "true" };
}

export function fieldNumber(field: GitField<number>): number | null {
  return field.state === "observed" ? field.value : null;
}

export async function detectOperation(
  gitExecutable: string,
  cwd: LocalPath,
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  probeGit: GitRunner,
): Promise<GitOperationState> {
  const refs: readonly { readonly ref: string; readonly state: GitOperationState }[] = [
    { ref: "MERGE_HEAD", state: "merge" },
    { ref: "REBASE_HEAD", state: "rebase" },
    { ref: "CHERRY_PICK_HEAD", state: "cherry-pick" },
    { ref: "REVERT_HEAD", state: "revert" },
    { ref: "BISECT_HEAD", state: "bisect" },
  ];
  for (const candidate of refs) {
    const probed = await probeGit(
      gitExecutable,
      cwd,
      ["rev-parse", "--revs-only", "--verify", "--quiet", candidate.ref],
      timeoutMs,
      signal,
      256,
    );
    if (probed.ok && (probed.value.exit.exitCode ?? 1) === 0) {
      return candidate.state;
    }
  }
  return "clean";
}

export function resolveOperation(
  probed: GitOperationState,
  entries: GitField<readonly GitStatusEntry[]>,
): GitOperationState {
  if (probed !== "clean") {
    return probed;
  }
  switch (entries.state) {
    case "unavailable":
      return "clean";
    case "observed":
    case "truncated":
      return entries.value.some((entry) => entry.kind === "unmerged") ? "merge" : "clean";
    default: {
      const _exhaustive: never = entries;
      return _exhaustive;
    }
  }
}
