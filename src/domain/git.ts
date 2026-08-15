/**
 * Git observation, safe branch/worktree, checkpoint, and commit-plan contracts
 * (#76/#78/#79/#80).
 *
 * Discovery, status, diff, log, and blame are typed snapshots. Branch create,
 * switch, and delete plus worktree add/list/remove are the only history-safe
 * mutations. Checkpoints snapshot index/worktree trees under
 * `refs/falryn/checkpoints/` and restore only after a preview. `planCommits`
 * returns grouping advice and never stages or commits. The host adapter runs
 * `git` through ProcessCapturePort. This module never stages or commits on the
 * user index, fetches, force-updates, stashes, or rewrites history, and it does
 * not register a product tool.
 */

import { type DurationMs, duration, type Instant } from "./clock.ts";
import type { LocalPath } from "./filesystem.ts";
import { parseLocalPath } from "./filesystem.ts";
import { isAbsoluteCommandPath } from "./process.ts";
import type { ProcessCaptureReport, ProcessCaptureStop } from "./process-capture.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_GIT_TIMEOUT_MS = duration(10_000);
export const DEFAULT_GIT_STATUS_ENTRIES = 256;
export const MAX_GIT_STATUS_ENTRIES = 1_024;
export const DEFAULT_GIT_DIFF_BYTES = 64 * 1_024;
export const MAX_GIT_DIFF_BYTES = 256 * 1_024;
export const DEFAULT_GIT_LOG_COMMITS = 32;
export const MAX_GIT_LOG_COMMITS = 128;
export const DEFAULT_GIT_BLAME_LINES = 512;
export const MAX_GIT_BLAME_LINES = 4_096;
export const MAX_GIT_REMOTE_URL_LENGTH = 512;
export const DEFAULT_GIT_WORKTREES = 32;
export const MAX_GIT_WORKTREES = 64;
export const MAX_GIT_REF_NAME_LENGTH = 255;
export const GIT_CHECKPOINT_REF_PREFIX = "refs/falryn/checkpoints/";
export const GIT_CHECKPOINT_VERSION = 1;
export const DEFAULT_GIT_CHECKPOINTS = 32;
export const MAX_GIT_CHECKPOINTS = 64;
export const MAX_GIT_CHECKPOINT_UNTRACKED = 32;
export const MAX_GIT_CHECKPOINT_REFERENCE_LENGTH = 128;
export const COMMIT_PLAN_VERSION = 1;
export const COMMIT_PLAN_SOURCE = "git-status-log" as const;
export const MAX_COMMIT_PLAN_GROUPS = 16;
export const COMMIT_CHANGE_STATES = ["staged", "unstaged", "untracked"] as const;
export type CommitChangeState = (typeof COMMIT_CHANGE_STATES)[number];

export const GIT_OBSERVATION_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "1",
  LC_ALL: "C",
};

export const GIT_INVOCATION_PREFIX = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "advice.detachedHead=false",
] as const;

export const GIT_HEAD_STATES = ["branch", "detached", "unborn"] as const;
export type GitHeadState = (typeof GIT_HEAD_STATES)[number];

export const GIT_OPERATION_STATES = [
  "clean",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "bisect",
] as const;
export type GitOperationState = (typeof GIT_OPERATION_STATES)[number];

export const GIT_CHANGE_KINDS = ["ordinary", "rename", "unmerged", "untracked", "ignored"] as const;
export type GitChangeKind = (typeof GIT_CHANGE_KINDS)[number];

export const GIT_DIFF_SCOPES = ["worktree", "index", "head"] as const;
export type GitDiffScope = (typeof GIT_DIFF_SCOPES)[number];

export type GitField<Value> =
  | { readonly state: "observed"; readonly value: Value }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "truncated"; readonly value: Value; readonly omitted: number };

export type GitError =
  | { readonly code: "invalid-request"; readonly reason: string }
  | { readonly code: "not-a-repository" }
  | { readonly code: "unsafe-ownership" }
  | { readonly code: "lock-contention" }
  | { readonly code: "cancelled" }
  | { readonly code: "timed-out" }
  | { readonly code: "output-exceeded" }
  | { readonly code: "spawn-failed"; readonly reason: string }
  | { readonly code: "operation-in-progress"; readonly operation: GitOperationState }
  | { readonly code: "dirty-worktree" }
  | { readonly code: "already-exists"; readonly reason: string }
  | { readonly code: "checked-out" }
  | { readonly code: "not-merged" }
  | { readonly code: "head-mismatch" }
  | { readonly code: "checkpoint-missing" }
  | { readonly code: "restore-ambiguous"; readonly reason: string }
  | { readonly code: "failed"; readonly reason: string };

export type GitRequestBase = {
  readonly gitExecutable: string;
  readonly startPath: string;
  readonly timeoutMs?: DurationMs | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type GitDiscoverRequest = GitRequestBase;

export type GitStatusRequest = GitRequestBase & {
  readonly includeIgnored?: boolean | undefined;
  readonly maxEntries?: number | undefined;
};

export type GitDiffRequest = GitRequestBase & {
  readonly scope?: GitDiffScope | undefined;
  readonly path?: string | undefined;
  readonly maxBytes?: number | undefined;
};

export type GitLogRequest = GitRequestBase & {
  readonly maxCount?: number | undefined;
  readonly path?: string | undefined;
};

export type GitBlameRequest = GitRequestBase & {
  readonly path: string;
  readonly revision?: string | undefined;
  readonly maxLines?: number | undefined;
};

export type GitExpectedHeadRequest = GitRequestBase & {
  readonly expectedHead?: string | undefined;
};

export type GitCreateBranchRequest = GitExpectedHeadRequest & {
  readonly name: string;
  readonly startPoint?: string | undefined;
};

export type GitSwitchBranchRequest = GitExpectedHeadRequest & {
  readonly name: string;
};

export type GitDeleteBranchRequest = GitExpectedHeadRequest & {
  readonly name: string;
};

export type GitListWorktreesRequest = GitRequestBase & {
  readonly maxEntries?: number | undefined;
};

export type GitCreateWorktreeRequest = GitExpectedHeadRequest & {
  readonly path: string;
  readonly startPoint?: string | undefined;
  readonly branch?: string | undefined;
  readonly detached?: boolean | undefined;
};

export type GitRemoveWorktreeRequest = GitExpectedHeadRequest & {
  readonly path: string;
};

export type GitCreateCheckpointRequest = GitExpectedHeadRequest & {
  readonly includeUntracked?: readonly string[] | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
};

export type GitListCheckpointsRequest = GitRequestBase & {
  readonly maxEntries?: number | undefined;
};

export type GitRestoreCheckpointRequest = GitExpectedHeadRequest & {
  readonly checkpointId: string;
};

export type GitPlanCommitsRequest = GitExpectedHeadRequest;

export type CommitChangeUnit = {
  readonly path: string;
  readonly originalPath: string | null;
  readonly kind: GitChangeKind;
  readonly states: readonly CommitChangeState[];
};

export type CommitGroup = {
  readonly id: string;
  readonly paths: readonly string[];
  readonly reason: string;
  readonly subject: string;
};

export type CommitUnassigned = {
  readonly path: string;
  readonly reason: string;
};

export type CommitPlanValidation = {
  readonly groupCount: number;
  readonly unassignedCount: number;
  readonly conflictCount: number;
  readonly secretPathCount: number;
  readonly truncated: boolean;
  readonly detached: boolean;
};

export type CommitPlanProvenance = {
  readonly version: number;
  readonly source: typeof COMMIT_PLAN_SOURCE;
  readonly model: null;
  readonly head: string | null;
  readonly truncated: boolean;
};

export type CommitPlan = {
  readonly inventory: readonly CommitChangeUnit[];
  readonly groups: readonly CommitGroup[];
  readonly unassigned: readonly CommitUnassigned[];
  readonly validation: CommitPlanValidation;
  readonly provenance: CommitPlanProvenance;
};

export type GitCommitPlanSnapshot = {
  readonly identity: GitIdentity;
  readonly plan: CommitPlan;
};

export type GitIdentity = {
  readonly worktreeRoot: LocalPath;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly head: GitField<string>;
  readonly headState: GitHeadState;
  readonly branch: GitField<string>;
  readonly upstream: GitField<string>;
  readonly ahead: GitField<number>;
  readonly behind: GitField<number>;
  readonly operation: GitOperationState;
  readonly superproject: GitField<string>;
  readonly sparseCheckout: GitField<boolean>;
  readonly gitVersion: GitField<string>;
  readonly remotes: GitField<readonly GitRemote[]>;
  readonly observedAt: Instant;
};

export type GitRemote = {
  readonly name: string;
  readonly url: string;
};

export type GitStatusEntry = {
  readonly kind: GitChangeKind;
  readonly path: string;
  readonly originalPath: string | null;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
};

export type GitStatusSnapshot = {
  readonly identity: GitIdentity;
  readonly entries: GitField<readonly GitStatusEntry[]>;
};

export type GitDiffSnapshot = {
  readonly identity: GitIdentity;
  readonly scope: GitDiffScope;
  readonly text: GitField<string>;
};

export type GitLogCommit = {
  readonly oid: string;
  readonly shortOid: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorAt: string;
  readonly subject: string;
};

export type GitLogSnapshot = {
  readonly identity: GitIdentity;
  readonly commits: GitField<readonly GitLogCommit[]>;
};

export type GitBlameLine = {
  readonly oid: string;
  readonly lineNumber: number;
  readonly path: string;
  readonly text: string;
};

export type GitBlameSnapshot = {
  readonly identity: GitIdentity;
  readonly path: string;
  readonly lines: GitField<readonly GitBlameLine[]>;
};

export const GIT_BRANCH_MUTATION_KINDS = [
  "create-branch",
  "switch-branch",
  "delete-branch",
] as const;
export type GitBranchMutationKind = (typeof GIT_BRANCH_MUTATION_KINDS)[number];

export type GitBranchMutation = {
  readonly identity: GitIdentity;
  readonly kind: GitBranchMutationKind;
  readonly name: string;
  readonly previousRef: string | null;
  readonly currentRef: string | null;
};

export type GitWorktreeRecord = {
  readonly path: string;
  readonly head: GitField<string>;
  readonly branch: GitField<string>;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
};

export type GitWorktreeList = {
  readonly identity: GitIdentity;
  readonly worktrees: GitField<readonly GitWorktreeRecord[]>;
};

export const GIT_WORKTREE_MUTATION_KINDS = ["create-worktree", "remove-worktree"] as const;
export type GitWorktreeMutationKind = (typeof GIT_WORKTREE_MUTATION_KINDS)[number];

export type GitWorktreeMutation = {
  readonly identity: GitIdentity;
  readonly kind: GitWorktreeMutationKind;
  readonly path: string;
  readonly worktree: GitWorktreeRecord | null;
};

export type GitCheckpointUntracked = {
  readonly path: string;
  readonly blob: string;
};

export type GitCheckpointRecord = {
  readonly id: string;
  readonly head: string;
  readonly headState: GitHeadState;
  readonly branch: string | null;
  readonly indexTree: string;
  readonly worktreeTree: string;
  readonly includedUntracked: readonly GitCheckpointUntracked[];
  readonly excludedUntracked: number;
  readonly truncated: boolean;
  readonly sessionId: string | null;
  readonly turnId: string | null;
};

export type GitCheckpointSnapshot = {
  readonly identity: GitIdentity;
  readonly checkpoint: GitCheckpointRecord;
};

export type GitCheckpointList = {
  readonly identity: GitIdentity;
  readonly checkpoints: GitField<readonly GitCheckpointRecord[]>;
};

export type GitRestorePlan = {
  readonly identity: GitIdentity;
  readonly checkpoint: GitCheckpointRecord;
  readonly indexChanged: boolean;
  readonly worktreePaths: readonly string[];
  readonly untrackedRestores: readonly string[];
};

export type GitRestoreResult = {
  readonly identity: GitIdentity;
  readonly checkpoint: GitCheckpointRecord;
  readonly restoredIndex: boolean;
  readonly restoredWorktree: readonly string[];
  readonly restoredUntracked: readonly string[];
};

export type GitPort = {
  discover(request: GitDiscoverRequest): Promise<Result<GitIdentity, GitError>>;
  status(request: GitStatusRequest): Promise<Result<GitStatusSnapshot, GitError>>;
  diff(request: GitDiffRequest): Promise<Result<GitDiffSnapshot, GitError>>;
  log(request: GitLogRequest): Promise<Result<GitLogSnapshot, GitError>>;
  blame(request: GitBlameRequest): Promise<Result<GitBlameSnapshot, GitError>>;
  listWorktrees(request: GitListWorktreesRequest): Promise<Result<GitWorktreeList, GitError>>;
  createBranch(request: GitCreateBranchRequest): Promise<Result<GitBranchMutation, GitError>>;
  switchBranch(request: GitSwitchBranchRequest): Promise<Result<GitBranchMutation, GitError>>;
  deleteBranch(request: GitDeleteBranchRequest): Promise<Result<GitBranchMutation, GitError>>;
  createWorktree(request: GitCreateWorktreeRequest): Promise<Result<GitWorktreeMutation, GitError>>;
  removeWorktree(request: GitRemoveWorktreeRequest): Promise<Result<GitWorktreeMutation, GitError>>;
  createCheckpoint(
    request: GitCreateCheckpointRequest,
  ): Promise<Result<GitCheckpointSnapshot, GitError>>;
  listCheckpoints(request: GitListCheckpointsRequest): Promise<Result<GitCheckpointList, GitError>>;
  planRestore(request: GitRestoreCheckpointRequest): Promise<Result<GitRestorePlan, GitError>>;
  restoreCheckpoint(
    request: GitRestoreCheckpointRequest,
  ): Promise<Result<GitRestoreResult, GitError>>;
  planCommits(request: GitPlanCommitsRequest): Promise<Result<GitCommitPlanSnapshot, GitError>>;
};

export type ParsedGitRequest = {
  readonly gitExecutable: LocalPath;
  readonly startPath: LocalPath;
  readonly timeoutMs: DurationMs;
  readonly signal: AbortSignal | undefined;
};

export function gitArgv(subcommand: readonly string[]): readonly string[] {
  return [...GIT_INVOCATION_PREFIX, ...subcommand];
}

export function redactGitRemoteUrl(url: string): string {
  const trimmed =
    url.length > MAX_GIT_REMOTE_URL_LENGTH ? url.slice(0, MAX_GIT_REMOTE_URL_LENGTH) : url;
  return trimmed.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

export function validateGitRequest(request: GitRequestBase): Result<ParsedGitRequest, GitError> {
  if (!isAbsoluteCommandPath(request.gitExecutable)) {
    return err({ code: "invalid-request", reason: "git-executable-not-absolute" });
  }
  const startPath = parseLocalPath(request.startPath);
  if (!startPath.ok) {
    return err({ code: "invalid-request", reason: startPath.error.code });
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  if (timeoutMs < 0) {
    return err({ code: "invalid-request", reason: "timeout-not-positive" });
  }
  return ok({
    gitExecutable: request.gitExecutable as LocalPath,
    startPath: startPath.value,
    timeoutMs,
    signal: request.signal,
  });
}

export function validateGitStatusLimits(maxEntries: number | undefined): Result<number, GitError> {
  const value = maxEntries ?? DEFAULT_GIT_STATUS_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    return err({ code: "invalid-request", reason: "max-entries" });
  }
  if (value > MAX_GIT_STATUS_ENTRIES) {
    return err({ code: "invalid-request", reason: "max-entries" });
  }
  return ok(value);
}

export function validateGitDiffLimits(
  scope: GitDiffScope | undefined,
  maxBytes: number | undefined,
  path: string | undefined,
): Result<
  { readonly scope: GitDiffScope; readonly maxBytes: number; readonly path: string | undefined },
  GitError
> {
  const resolvedScope = scope ?? "head";
  if (!GIT_DIFF_SCOPES.includes(resolvedScope)) {
    return err({ code: "invalid-request", reason: "diff-scope" });
  }
  const bytes = maxBytes ?? DEFAULT_GIT_DIFF_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_GIT_DIFF_BYTES) {
    return err({ code: "invalid-request", reason: "max-bytes" });
  }
  if (path !== undefined && (path.length === 0 || path.includes("\0"))) {
    return err({ code: "invalid-request", reason: "diff-path" });
  }
  return ok({ scope: resolvedScope, maxBytes: bytes, path });
}

export function validateGitLogLimits(
  maxCount: number | undefined,
  path: string | undefined,
): Result<{ readonly maxCount: number; readonly path: string | undefined }, GitError> {
  const count = maxCount ?? DEFAULT_GIT_LOG_COMMITS;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_GIT_LOG_COMMITS) {
    return err({ code: "invalid-request", reason: "max-count" });
  }
  if (path !== undefined && (path.length === 0 || path.includes("\0"))) {
    return err({ code: "invalid-request", reason: "log-path" });
  }
  return ok({ maxCount: count, path });
}

export function validateGitBlameRequest(
  path: string,
  revision: string | undefined,
  maxLines: number | undefined,
): Result<
  { readonly path: string; readonly revision: string | undefined; readonly maxLines: number },
  GitError
> {
  if (path.length === 0 || path.includes("\0") || path.startsWith("-")) {
    return err({ code: "invalid-request", reason: "blame-path" });
  }
  if (
    revision !== undefined &&
    (revision.length === 0 || revision.includes("\0") || revision.startsWith("-"))
  ) {
    return err({ code: "invalid-request", reason: "blame-revision" });
  }
  const lines = maxLines ?? DEFAULT_GIT_BLAME_LINES;
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_GIT_BLAME_LINES) {
    return err({ code: "invalid-request", reason: "max-lines" });
  }
  return ok({ path, revision, maxLines: lines });
}

export function validateGitRefName(name: string): Result<string, GitError> {
  if (
    name.length === 0 ||
    name.length > MAX_GIT_REF_NAME_LENGTH ||
    name === "HEAD" ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.includes("\0") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name.includes("\\") ||
    /[\s~^:?*[\]]/.test(name)
  ) {
    return err({ code: "invalid-request", reason: "ref-name" });
  }
  return ok(name);
}

export function validateGitRevision(revision: string): Result<string, GitError> {
  if (
    revision.length === 0 ||
    revision.length > MAX_GIT_REF_NAME_LENGTH ||
    revision.includes("\0")
  ) {
    return err({ code: "invalid-request", reason: "revision" });
  }
  if (revision.startsWith("-")) {
    return err({ code: "invalid-request", reason: "revision" });
  }
  return ok(revision);
}

export function validateGitWorktreeLimits(
  maxEntries: number | undefined,
): Result<number, GitError> {
  const value = maxEntries ?? DEFAULT_GIT_WORKTREES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GIT_WORKTREES) {
    return err({ code: "invalid-request", reason: "max-entries" });
  }
  return ok(value);
}

export function validateGitCheckpointLimits(
  maxEntries: number | undefined,
): Result<number, GitError> {
  const value = maxEntries ?? DEFAULT_GIT_CHECKPOINTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GIT_CHECKPOINTS) {
    return err({ code: "invalid-request", reason: "max-entries" });
  }
  return ok(value);
}

export function validateGitOid(value: string): Result<string, GitError> {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    return err({ code: "invalid-request", reason: "oid" });
  }
  return ok(value);
}

export function validateGitRelPath(path: string): Result<string, GitError> {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("-") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return err({ code: "invalid-request", reason: "path" });
  }
  return ok(path);
}

export function validateGitCheckpointReference(
  value: string | undefined,
): Result<string | null, GitError> {
  if (value === undefined) {
    return ok(null);
  }
  if (value.length === 0 || value.length > MAX_GIT_CHECKPOINT_REFERENCE_LENGTH) {
    return err({ code: "invalid-request", reason: "checkpoint-reference" });
  }
  if (value.includes("\0")) {
    return err({ code: "invalid-request", reason: "checkpoint-reference" });
  }
  return ok(value);
}

export function validateGitIncludeUntracked(
  paths: readonly string[] | undefined,
): Result<readonly string[], GitError> {
  if (paths === undefined) {
    return ok([]);
  }
  if (paths.length > MAX_GIT_CHECKPOINT_UNTRACKED) {
    return err({ code: "invalid-request", reason: "include-untracked" });
  }
  const unique = new Set<string>();
  const validated: string[] = [];
  for (const path of paths) {
    const parsed = validateGitRelPath(path);
    if (!parsed.ok) {
      return parsed;
    }
    if (unique.has(parsed.value)) {
      return err({ code: "invalid-request", reason: "include-untracked" });
    }
    unique.add(parsed.value);
    validated.push(parsed.value);
  }
  return ok(validated);
}

export function gitCheckpointRef(id: string): string {
  return `${GIT_CHECKPOINT_REF_PREFIX}${id}`;
}

export function formatGitCheckpointMessage(record: Omit<GitCheckpointRecord, "id">): string {
  return `falryn-checkpoint v${GIT_CHECKPOINT_VERSION}\n${JSON.stringify({
    version: GIT_CHECKPOINT_VERSION,
    head: record.head,
    headState: record.headState,
    branch: record.branch,
    indexTree: record.indexTree,
    worktreeTree: record.worktreeTree,
    includedUntracked: record.includedUntracked,
    excludedUntracked: record.excludedUntracked,
    truncated: record.truncated,
    sessionId: record.sessionId,
    turnId: record.turnId,
  })}`;
}

export function parseGitCheckpointMessage(
  id: string,
  message: string,
): Result<GitCheckpointRecord, GitError> {
  const trimmed = message.replace(/\n+$/, "");
  const prefix = `falryn-checkpoint v${GIT_CHECKPOINT_VERSION}\n`;
  if (!trimmed.startsWith(prefix)) {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(prefix.length));
  } catch {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (parsed === null || typeof parsed !== "object") {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  const body = parsed as Record<string, unknown>;
  if (body.version !== GIT_CHECKPOINT_VERSION) {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  const head = asOid(body.head);
  const indexTree = asOid(body.indexTree);
  const worktreeTree = asOid(body.worktreeTree);
  const headState = asHeadState(body.headState);
  if (head === null || indexTree === null || worktreeTree === null || headState === null) {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (body.branch !== null && typeof body.branch !== "string") {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (typeof body.excludedUntracked !== "number" || !Number.isSafeInteger(body.excludedUntracked)) {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (typeof body.truncated !== "boolean") {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  const included = asIncludedUntracked(body.includedUntracked);
  if (included === null) {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (body.sessionId !== null && typeof body.sessionId !== "string") {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  if (body.turnId !== null && typeof body.turnId !== "string") {
    return err({ code: "failed", reason: "checkpoint-unparsed" });
  }
  return ok({
    id,
    head,
    headState,
    branch: body.branch,
    indexTree,
    worktreeTree,
    includedUntracked: included,
    excludedUntracked: body.excludedUntracked,
    truncated: body.truncated,
    sessionId: body.sessionId,
    turnId: body.turnId,
  });
}

export function parseGitCheckpointRefs(
  stdout: string,
  maxEntries: number,
): GitField<readonly string[]> {
  const ids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}$/.test(line));
  const omitted = Math.max(0, ids.length - maxEntries);
  const kept = omitted > 0 ? ids.slice(0, maxEntries) : ids;
  if (omitted > 0) {
    return { state: "truncated", value: kept, omitted };
  }
  return { state: "observed", value: kept };
}

export function refuseUnsafeGitIdentity(
  identity: GitIdentity,
  expectedHead: string | undefined,
): GitError | null {
  if (identity.operation !== "clean") {
    return { code: "operation-in-progress", operation: identity.operation };
  }
  if (expectedHead === undefined) {
    return null;
  }
  if (identity.head.state !== "observed" || identity.head.value !== expectedHead) {
    return { code: "head-mismatch" };
  }
  return null;
}

export function worktreeHasBlockingChanges(entries: GitField<readonly GitStatusEntry[]>): boolean {
  switch (entries.state) {
    case "unavailable":
      return true;
    case "observed":
    case "truncated":
      return entries.value.some(
        (entry) =>
          entry.kind === "ordinary" ||
          entry.kind === "rename" ||
          entry.kind === "unmerged" ||
          entry.kind === "untracked",
      );
    default: {
      const _exhaustive: never = entries;
      return assertNever(_exhaustive, "unhandled status field");
    }
  }
}

export function gitFailureFromCapture(report: ProcessCaptureReport): GitError | null {
  const fromStop = gitFailureFromStop(report.stop);
  if (fromStop !== null) {
    return fromStop;
  }
  const exitCode = report.exit.exitCode;
  if (exitCode === 0 || exitCode === null) {
    return exitCode === 0 ? null : { code: "failed", reason: "missing-exit" };
  }
  const stderr = report.stderr.inlineText ?? "";
  return classifyGitStderr(exitCode, stderr);
}

export function gitFailureFromStop(stop: ProcessCaptureStop): GitError | null {
  switch (stop.kind) {
    case "exited":
      return null;
    case "cancelled":
      return { code: "cancelled" };
    case "timed-out":
      return { code: "timed-out" };
    case "capture-exceeded":
      return { code: "output-exceeded" };
    case "uncertain":
      return { code: "failed", reason: stop.reason };
    default: {
      const _exhaustive: never = stop;
      return assertNever(_exhaustive, "unhandled capture stop");
    }
  }
}

export function classifyGitStderr(exitCode: number, stderr: string): GitError {
  const text = stderr.toLowerCase();
  if (text.includes("dubious ownership") || text.includes("unsafe repository")) {
    return { code: "unsafe-ownership" };
  }
  if (text.includes("unable to create") && text.includes(".lock")) {
    return { code: "lock-contention" };
  }
  if (text.includes("not a git repository") || text.includes("not a git dir")) {
    return { code: "not-a-repository" };
  }
  if (
    text.includes("already checked out") ||
    text.includes("checked out at") ||
    text.includes("already used by worktree")
  ) {
    return { code: "checked-out" };
  }
  if (text.includes("not fully merged") || text.includes("is not merged")) {
    return { code: "not-merged" };
  }
  if (
    text.includes("local changes") ||
    text.includes("would be overwritten") ||
    text.includes("modified or untracked") ||
    text.includes("contains modified")
  ) {
    return { code: "dirty-worktree" };
  }
  if (text.includes("already exists") || text.includes("a branch named")) {
    return { code: "already-exists", reason: "name" };
  }
  if (text.includes("main working tree")) {
    return { code: "invalid-request", reason: "main-worktree" };
  }
  if (
    text.includes("bad object") ||
    text.includes("unknown revision") ||
    text.includes("needed a single revision") ||
    text.includes("not a valid object")
  ) {
    return { code: "checkpoint-missing" };
  }
  if (exitCode === 128) {
    return { code: "not-a-repository" };
  }
  return { code: "failed", reason: `exit-${exitCode}` };
}

export function parseGitVersion(stdout: string): GitField<string> {
  const match = /^git version (.+)$/m.exec(stdout.trim());
  if (match?.[1] === undefined) {
    return { state: "unavailable", reason: "unparsed-version" };
  }
  return { state: "observed", value: match[1].trim() };
}

export function parseStatusPorcelainV2(
  stdout: string,
  maxEntries: number,
): {
  readonly head: GitField<string>;
  readonly headState: GitHeadState;
  readonly branch: GitField<string>;
  readonly upstream: GitField<string>;
  readonly ahead: GitField<number>;
  readonly behind: GitField<number>;
  readonly entries: GitField<readonly GitStatusEntry[]>;
} {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  let oid: string | null = null;
  let headName: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const entries: GitStatusEntry[] = [];
  let pendingRename: GitStatusEntry | null = null;

  for (const record of records) {
    if (pendingRename !== null && pendingRename.originalPath === null) {
      entries.push({ ...pendingRename, originalPath: record });
      pendingRename = null;
      continue;
    }
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      oid = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      headName = record.slice("# branch.head ".length);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^\+(-?\d+) -(-?\d+)$/.exec(record.slice("# branch.ab ".length).trim());
      if (match?.[1] !== undefined && match[2] !== undefined) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("# ")) {
      continue;
    }
    const parsed = parseStatusEntry(record);
    if (parsed === null) {
      continue;
    }
    if (parsed.kind === "rename" && parsed.originalPath === null) {
      pendingRename = parsed;
      continue;
    }
    entries.push(parsed);
  }
  if (pendingRename !== null) {
    entries.push(pendingRename);
  }

  const headState: GitHeadState =
    oid === null ? "unborn" : headName === "(detached)" ? "detached" : "branch";
  const omitted = Math.max(0, entries.length - maxEntries);
  const kept = omitted > 0 ? entries.slice(0, maxEntries) : entries;

  return {
    head:
      oid === null ? { state: "unavailable", reason: "unborn" } : { state: "observed", value: oid },
    headState,
    branch:
      headName === null || headName === "(detached)"
        ? { state: "unavailable", reason: headState }
        : { state: "observed", value: headName },
    upstream:
      upstream === null
        ? { state: "unavailable", reason: "no-upstream" }
        : { state: "observed", value: upstream },
    ahead:
      ahead === null
        ? { state: "unavailable", reason: "no-upstream" }
        : { state: "observed", value: ahead },
    behind:
      behind === null
        ? { state: "unavailable", reason: "no-upstream" }
        : { state: "observed", value: behind },
    entries:
      omitted > 0
        ? { state: "truncated", value: kept, omitted }
        : { state: "observed", value: kept },
  };
}

export function parseGitLog(stdout: string, maxCount: number): GitField<readonly GitLogCommit[]> {
  const lines = stdout.length === 0 ? [] : stdout.replace(/\n$/, "").split("\n");
  const commits: GitLogCommit[] = [];
  for (const line of lines) {
    const parts = line.split("\x1f");
    if (parts.length < 6) {
      continue;
    }
    const [oid, shortOid, authorName, authorEmail, authorAt, subject] = parts;
    if (
      oid === undefined ||
      shortOid === undefined ||
      authorName === undefined ||
      authorEmail === undefined ||
      authorAt === undefined ||
      subject === undefined
    ) {
      continue;
    }
    commits.push({ oid, shortOid, authorName, authorEmail, authorAt, subject });
  }
  const omitted = Math.max(0, commits.length - maxCount);
  const kept = omitted > 0 ? commits.slice(0, maxCount) : commits;
  if (omitted > 0) {
    return { state: "truncated", value: kept, omitted };
  }
  return { state: "observed", value: kept };
}

export function parseGitBlame(stdout: string, maxLines: number): GitField<readonly GitBlameLine[]> {
  const lines: GitBlameLine[] = [];
  const records = stdout.split("\n");
  let oid = "";
  let lineNumber = 0;
  let path = "";
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(record);
    if (header?.[1] !== undefined && header[3] !== undefined) {
      oid = header[1];
      lineNumber = Number(header[3]);
      continue;
    }
    if (record.startsWith("filename ")) {
      path = record.slice("filename ".length);
      continue;
    }
    if (record.startsWith("\t")) {
      lines.push({ oid, lineNumber, path, text: record.slice(1) });
    }
  }
  const omitted = Math.max(0, lines.length - maxLines);
  const kept = omitted > 0 ? lines.slice(0, maxLines) : lines;
  if (omitted > 0) {
    return { state: "truncated", value: kept, omitted };
  }
  return { state: "observed", value: kept };
}

export function parseGitRemotes(stdout: string): GitField<readonly GitRemote[]> {
  if (stdout.trim().length === 0) {
    return { state: "observed", value: [] };
  }
  const remotes: GitRemote[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    remotes.push({ name: match[1], url: redactGitRemoteUrl(match[2]) });
  }
  return { state: "observed", value: remotes };
}

export function parseRevParsePaths(stdout: string): {
  readonly worktreeRoot: string | null;
  readonly gitDir: string | null;
  readonly commonDir: string | null;
  readonly superproject: string | null;
} {
  const lines = stdout.replace(/\n$/, "").split("\n");
  return {
    worktreeRoot: emptyToNull(lines[0]),
    gitDir: emptyToNull(lines[1]),
    commonDir: emptyToNull(lines[2]),
    superproject: emptyToNull(lines[3]),
  };
}

export function parseGitWorktrees(
  stdout: string,
  maxEntries: number,
): GitField<readonly GitWorktreeRecord[]> {
  const records = stdout.split("\0");
  const worktrees: GitWorktreeRecord[] = [];
  let current: {
    path?: string;
    head?: GitField<string>;
    branch?: GitField<string>;
    detached?: boolean;
    locked?: boolean;
    prunable?: boolean;
  } = {};

  const flush = (): void => {
    if (current.path === undefined) {
      current = {};
      return;
    }
    worktrees.push({
      path: current.path,
      head: current.head ?? { state: "unavailable", reason: "missing-head" },
      branch: current.branch ?? { state: "unavailable", reason: "detached" },
      detached: current.detached === true,
      locked: current.locked === true,
      prunable: current.prunable === true,
    });
    current = {};
  };

  for (const record of records) {
    if (record.length === 0) {
      flush();
      continue;
    }
    if (record.startsWith("worktree ")) {
      flush();
      current = { path: record.slice("worktree ".length) };
      continue;
    }
    if (record.startsWith("HEAD ")) {
      current.head = { state: "observed", value: record.slice("HEAD ".length) };
      continue;
    }
    if (record.startsWith("branch ")) {
      const ref = record.slice("branch ".length);
      current.branch = {
        state: "observed",
        value: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref,
      };
      current.detached = false;
      continue;
    }
    if (record === "detached") {
      current.detached = true;
      current.branch = { state: "unavailable", reason: "detached" };
      continue;
    }
    if (record === "bare") {
      current.detached = false;
      continue;
    }
    if (record === "locked" || record.startsWith("locked ")) {
      current.locked = true;
      continue;
    }
    if (record === "prunable" || record.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();

  const omitted = Math.max(0, worktrees.length - maxEntries);
  const kept = omitted > 0 ? worktrees.slice(0, maxEntries) : worktrees;
  if (omitted > 0) {
    return { state: "truncated", value: kept, omitted };
  }
  return { state: "observed", value: kept };
}

function asOid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function asHeadState(value: unknown): GitHeadState | null {
  if (value === "branch" || value === "detached" || value === "unborn") {
    return value;
  }
  return null;
}

function asIncludedUntracked(value: unknown): readonly GitCheckpointUntracked[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const included: GitCheckpointUntracked[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.blob !== "string") {
      return null;
    }
    if (!/^[0-9a-f]{40}$/.test(record.blob)) {
      return null;
    }
    included.push({ path: record.path, blob: record.blob });
  }
  return included;
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  return value;
}

function parseStatusEntry(record: string): GitStatusEntry | null {
  if (record.startsWith("? ")) {
    return {
      kind: "untracked",
      path: record.slice(2),
      originalPath: null,
      indexStatus: "?",
      worktreeStatus: "?",
    };
  }
  if (record.startsWith("! ")) {
    return {
      kind: "ignored",
      path: record.slice(2),
      originalPath: null,
      indexStatus: "!",
      worktreeStatus: "!",
    };
  }
  if (record.startsWith("u ")) {
    const match = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    const xy = match?.[1] ?? record.slice(2, 4);
    return {
      kind: "unmerged",
      path: match?.[2] ?? record.slice(2),
      originalPath: null,
      indexStatus: xy[0] ?? "U",
      worktreeStatus: xy[1] ?? "U",
    };
  }
  if (record.startsWith("1 ")) {
    const match = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    const xy = match?.[1] ?? record.slice(2, 4);
    return {
      kind: "ordinary",
      path: match?.[2] ?? record.slice(2),
      originalPath: null,
      indexStatus: xy[0] ?? ".",
      worktreeStatus: xy[1] ?? ".",
    };
  }
  if (record.startsWith("2 ")) {
    const match = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record);
    const xy = match?.[1] ?? record.slice(2, 4);
    const names = (match?.[2] ?? "").split("\t");
    return {
      kind: "rename",
      path: names[0] ?? "",
      originalPath: names[1] ?? null,
      indexStatus: xy[0] ?? ".",
      worktreeStatus: xy[1] ?? ".",
    };
  }
  return null;
}
