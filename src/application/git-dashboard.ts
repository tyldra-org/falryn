/**
 * Application boundary for the Git changes dashboard (#268).
 *
 * Observes status, worktrees, and checkpoints through GitPort. Checkpoint
 * create/restore go through the same port; the TUI never spawns git.
 */

import {
  err,
  type GitCheckpointRecord,
  type GitCheckpointSnapshot,
  type GitError,
  type GitField,
  type GitIdentity,
  type GitPort,
  type GitRestoreResult,
  type GitStatusEntry,
  type GitWorktreeRecord,
  ok,
  type Result,
} from "../domain/index.ts";

export type GitDashboardSnapshot = {
  readonly identity: GitIdentity;
  readonly entries: readonly GitStatusEntry[];
  readonly entriesNote: string | null;
  readonly worktrees: readonly GitWorktreeRecord[];
  readonly worktreesNote: string | null;
  readonly checkpoints: readonly GitCheckpointRecord[];
  readonly checkpointsNote: string | null;
};

export type GitDashboard = {
  snapshot(signal?: AbortSignal): Promise<Result<GitDashboardSnapshot, GitError>>;
  createCheckpoint(signal?: AbortSignal): Promise<Result<GitCheckpointSnapshot, GitError>>;
  restoreCheckpoint(
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<Result<GitRestoreResult, GitError>>;
};

export type GitDashboardOptions = {
  readonly git: GitPort;
  readonly gitExecutable: string;
  readonly startPath: string;
};

export function createGitDashboard(options: GitDashboardOptions): GitDashboard {
  const base = {
    gitExecutable: options.gitExecutable,
    startPath: options.startPath,
  };

  return {
    async snapshot(signal) {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      const status = await options.git.status({ ...base, signal });
      if (!status.ok) {
        return status;
      }
      const entries = fromField(status.value.entries);
      const worktrees = await options.git.listWorktrees({ ...base, signal });
      const checkpoints = await options.git.listCheckpoints({ ...base, signal });
      return ok({
        identity: status.value.identity,
        entries: entries.entries,
        entriesNote: entries.note,
        worktrees: worktrees.ok ? fromField(worktrees.value.worktrees).entries : [],
        worktreesNote: worktrees.ok
          ? fromField(worktrees.value.worktrees).note
          : describeGitError(worktrees.error),
        checkpoints: checkpoints.ok ? fromField(checkpoints.value.checkpoints).entries : [],
        checkpointsNote: checkpoints.ok
          ? fromField(checkpoints.value.checkpoints).note
          : describeGitError(checkpoints.error),
      });
    },

    async createCheckpoint(signal) {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      const discovered = await options.git.discover({ ...base, signal });
      if (!discovered.ok) {
        return discovered;
      }
      return options.git.createCheckpoint({
        ...base,
        signal,
        ...expectedHeadOf(discovered.value),
      });
    },

    async restoreCheckpoint(checkpointId, signal) {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      const discovered = await options.git.discover({ ...base, signal });
      if (!discovered.ok) {
        return discovered;
      }
      const planned = await options.git.planRestore({
        ...base,
        signal,
        checkpointId,
        ...expectedHeadOf(discovered.value),
      });
      if (!planned.ok) {
        return planned;
      }
      return options.git.restoreCheckpoint({
        ...base,
        signal,
        checkpointId,
        ...expectedHeadOf(discovered.value),
      });
    },
  };
}

export function describeGitError(error: GitError): string {
  switch (error.code) {
    case "failed":
    case "invalid-request":
    case "spawn-failed":
    case "already-exists":
    case "restore-ambiguous":
    case "rejected":
    case "hook-failed":
    case "signing-failed":
      return error.reason;
    case "operation-in-progress":
      return `git is busy (${error.operation})`;
    case "secret-path":
      return `refused a secret path: ${error.path}`;
    default:
      return error.code;
  }
}

function expectedHeadOf(identity: GitIdentity): { readonly expectedHead?: string } {
  return identity.head.state === "observed" ? { expectedHead: identity.head.value } : {};
}

function fromField<T>(field: GitField<readonly T[]>): {
  readonly entries: readonly T[];
  readonly note: string | null;
} {
  switch (field.state) {
    case "observed":
      return { entries: field.value, note: null };
    case "truncated":
      return {
        entries: field.value,
        note: `${field.omitted} more omitted.`,
      };
    case "unavailable":
      return { entries: [], note: field.reason };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}
