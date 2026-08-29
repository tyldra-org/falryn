/** Stable Git requests, snapshots, mutations, and port contracts. */

import { type DurationMs, duration, type Instant } from "../clock.ts";
import type { LocalPath } from "../filesystem.ts";
import type { Result } from "../result.ts";

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
export const DEFAULT_GIT_REMOTE_NAME = "origin";
export const MAX_GIT_STAGE_PATHS = 256;
export const MAX_GIT_COMMIT_SUBJECT_LENGTH = 72;

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

export const GIT_USER_HOOK_INVOCATION_PREFIX = [
  "--no-pager",
  "--literal-pathspecs",
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
  | { readonly code: "secret-path"; readonly path: string }
  | { readonly code: "empty-index" }
  | { readonly code: "no-upstream" }
  | { readonly code: "non-fast-forward" }
  | { readonly code: "rejected"; readonly reason: string }
  | { readonly code: "authentication" }
  | { readonly code: "hook-failed"; readonly reason: string }
  | { readonly code: "signing-failed"; readonly reason: string }
  | { readonly code: "diverged" }
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

export type GitStageRequest = GitExpectedHeadRequest & {
  readonly paths: readonly string[];
};

export type GitUnstageRequest = GitStageRequest;

export type GitCommitRequest = GitExpectedHeadRequest & {
  readonly subject: string;
};

export type GitRemoteMutationRequest = GitExpectedHeadRequest & {
  readonly remote?: string | undefined;
};

export type GitFetchRequest = GitRemoteMutationRequest;
export type GitPullRequest = GitRemoteMutationRequest;
export type GitPushRequest = GitRemoteMutationRequest;
export type GitSyncRequest = GitRemoteMutationRequest;

export type GitIndexMutation = {
  readonly identity: GitIdentity;
  readonly paths: readonly string[];
};

export type GitCommitResult = {
  readonly identity: GitIdentity;
  readonly oid: string;
  readonly subject: string;
};

export type GitRemoteResult = {
  readonly identity: GitIdentity;
  readonly remote: string;
};

export type GitSyncResult = {
  readonly identity: GitIdentity;
  readonly remote: string;
  readonly fetched: boolean;
  readonly fastForwarded: boolean;
  readonly pushed: boolean;
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
  stage(request: GitStageRequest): Promise<Result<GitIndexMutation, GitError>>;
  unstage(request: GitUnstageRequest): Promise<Result<GitIndexMutation, GitError>>;
  commit(request: GitCommitRequest): Promise<Result<GitCommitResult, GitError>>;
  fetch(request: GitFetchRequest): Promise<Result<GitRemoteResult, GitError>>;
  pull(request: GitPullRequest): Promise<Result<GitRemoteResult, GitError>>;
  push(request: GitPushRequest): Promise<Result<GitRemoteResult, GitError>>;
  sync(request: GitSyncRequest): Promise<Result<GitSyncResult, GitError>>;
};

export type ParsedGitRequest = {
  readonly gitExecutable: LocalPath;
  readonly startPath: LocalPath;
  readonly timeoutMs: DurationMs;
  readonly signal: AbortSignal | undefined;
};
