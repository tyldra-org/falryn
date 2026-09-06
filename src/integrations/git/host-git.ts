/**
 * Host Git observation, safe branch/worktree, checkpoint, commit-plan, and
 * stage/commit/sync adapter (#76/#78/#79/#80/#283).
 *
 * Runs `git` through ProcessCapturePort with a complete supplied environment
 * and a structured argv. Stderr is classified into typed failures and then
 * dropped. Force-update, rebase, stash, and history rewrite are never used.
 */

export type { HostGitOptions } from "./host-git/contracts.ts";

import { err, ok } from "../../domain/foundation/result.ts";
import {
  DEFAULT_GIT_LOG_COMMITS,
  GIT_CHECKPOINT_REF_PREFIX,
  type GitBlameRequest,
  type GitBlameSnapshot,
  type GitBranchMutation,
  type GitCheckpointList,
  type GitCheckpointRecord,
  type GitCheckpointSnapshot,
  type GitCommitPlanSnapshot,
  type GitCommitRequest,
  type GitCommitResult,
  type GitCreateBranchRequest,
  type GitCreateCheckpointRequest,
  type GitCreateWorktreeRequest,
  type GitDeleteBranchRequest,
  type GitDiffRequest,
  type GitDiffSnapshot,
  type GitDiscoverRequest,
  type GitIndexMutation,
  type GitListCheckpointsRequest,
  type GitListWorktreesRequest,
  type GitLogRequest,
  type GitLogSnapshot,
  type GitPlanCommitsRequest,
  type GitPort,
  type GitRemoveWorktreeRequest,
  type GitRestoreCheckpointRequest,
  type GitRestoreResult,
  type GitStageRequest,
  type GitStatusRequest,
  type GitStatusSnapshot,
  type GitSwitchBranchRequest,
  type GitUnstageRequest,
  type GitWorktreeList,
  type GitWorktreeMutation,
  gitFailureFromCapture,
  indexHasStagedChanges,
  parseGitBlame,
  parseGitCheckpointRefs,
  parseGitLog,
  parseGitWorktrees,
  parseStatusPorcelainV2,
  planGitCommits,
  stagedSecretPath,
  validateGitBlameRequest,
  validateGitCheckpointLimits,
  validateGitCheckpointReference,
  validateGitCommitSubject,
  validateGitDiffLimits,
  validateGitIncludeUntracked,
  validateGitLogLimits,
  validateGitPathspecs,
  validateGitRefName,
  validateGitRequest,
  validateGitRevision,
  validateGitStagePaths,
  validateGitStatusLimits,
  validateGitWorktreeLimits,
  worktreeHasBlockingChanges,
} from "../../domain/git/index.ts";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../domain/process/index.ts";
import { parseLocalPath } from "../../domain/workspace/index.ts";
import type { HostGitOptions } from "./host-git/contracts.ts";
import { createGitRemoteOperations } from "./host-git/remote-operations.ts";
import {
  buildRestorePlan,
  diffArgv,
  listWorktreeAt,
  loadCheckpointRecord,
  prepareMutation,
  reloadIdentity,
  restoreUntrackedBlob,
  sameWorktreePath,
  snapshotCheckpoint,
  statusAt,
} from "./host-git/support.ts";
import { createGitExecution } from "./host-git/transport.ts";

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

export function createHostGitPort(options: HostGitOptions): GitPort {
  const { probeGit, runGit, runGitWithUserHooks, loadIdentity } = createGitExecution(options);

  return {
    async discover(request: GitDiscoverRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      return loadIdentity(
        parsed.value.gitExecutable,
        parsed.value.startPath,
        parsed.value.timeoutMs,
        parsed.value.signal,
      );
    },

    async status(request: GitStatusRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitStatusLimits(request.maxEntries);
      if (!limits.ok) {
        return limits;
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
      const subcommand = [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        ...(request.includeIgnored === true ? ["--ignored=matching"] : []),
      ];
      const report = await runGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        subcommand,
        parsed.value.timeoutMs,
        parsed.value.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!report.ok) {
        return report;
      }
      const parsedStatus = parseStatusPorcelainV2(
        report.value.stdout.inlineText ?? "",
        limits.value,
      );
      return ok({
        identity: identity.value,
        entries: parsedStatus.entries,
      } satisfies GitStatusSnapshot);
    },

    async diff(request: GitDiffRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitDiffLimits(request.scope, request.maxBytes, request.path);
      if (!limits.ok) {
        return limits;
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
      const report = await probeGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        diffArgv(limits.value.scope, limits.value.path),
        parsed.value.timeoutMs,
        parsed.value.signal,
        limits.value.maxBytes,
      );
      if (!report.ok) {
        if (report.error.code === "output-exceeded") {
          return ok({
            identity: identity.value,
            scope: limits.value.scope,
            text: { state: "truncated", value: "", omitted: 1 },
          } satisfies GitDiffSnapshot);
        }
        return report;
      }
      const failed = gitFailureFromCapture(report.value);
      if (failed !== null && failed.code !== "output-exceeded") {
        return err(failed);
      }
      const text = report.value.stdout.inlineText ?? "";
      const truncated = report.value.stdout.truncated || failed?.code === "output-exceeded";
      return ok({
        identity: identity.value,
        scope: limits.value.scope,
        text: truncated
          ? { state: "truncated", value: text, omitted: report.value.stdout.omittedBytes }
          : { state: "observed", value: text },
      } satisfies GitDiffSnapshot);
    },

    async log(request: GitLogRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitLogLimits(request.maxCount, request.path);
      if (!limits.ok) {
        return limits;
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
      const subcommand = [
        "log",
        "--no-color",
        `--max-count=${limits.value.maxCount}`,
        `--format=${LOG_FORMAT}`,
        ...(limits.value.path === undefined ? [] : ["--", limits.value.path]),
      ];
      const report = await probeGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        subcommand,
        parsed.value.timeoutMs,
        parsed.value.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!report.ok) {
        return report;
      }
      if ((report.value.exit.exitCode ?? 1) !== 0) {
        if (identity.value.headState === "unborn") {
          return ok({
            identity: identity.value,
            commits: { state: "observed", value: [] },
          } satisfies GitLogSnapshot);
        }
        return err(gitFailureFromCapture(report.value) ?? { code: "failed", reason: "log" });
      }
      return ok({
        identity: identity.value,
        commits: parseGitLog(report.value.stdout.inlineText ?? "", limits.value.maxCount),
      } satisfies GitLogSnapshot);
    },

    async blame(request: GitBlameRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitBlameRequest(request.path, request.revision, request.maxLines);
      if (!limits.ok) {
        return limits;
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
      const subcommand = [
        "blame",
        "--porcelain",
        ...(limits.value.revision === undefined ? [] : [limits.value.revision]),
        "--",
        limits.value.path,
      ];
      const report = await runGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        subcommand,
        parsed.value.timeoutMs,
        parsed.value.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!report.ok) {
        return report;
      }
      return ok({
        identity: identity.value,
        path: limits.value.path,
        lines: parseGitBlame(report.value.stdout.inlineText ?? "", limits.value.maxLines),
      } satisfies GitBlameSnapshot);
    },

    async listWorktrees(request: GitListWorktreesRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitWorktreeLimits(request.maxEntries);
      if (!limits.ok) {
        return limits;
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
      const report = await runGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        ["worktree", "list", "--porcelain", "-z"],
        parsed.value.timeoutMs,
        parsed.value.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!report.ok) {
        return report;
      }
      return ok({
        identity: identity.value,
        worktrees: parseGitWorktrees(report.value.stdout.inlineText ?? "", limits.value),
      } satisfies GitWorktreeList);
    },

    async createBranch(request: GitCreateBranchRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const name = validateGitRefName(request.name);
      if (!name.ok) {
        return name;
      }
      const start =
        request.startPoint === undefined
          ? mutation.identity.head.state === "observed"
            ? ok(mutation.identity.head.value)
            : err({ code: "invalid-request" as const, reason: "unborn" })
          : validateGitRevision(request.startPoint);
      if (!start.ok) {
        return start;
      }
      const report = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["branch", "--", name.value, start.value],
        mutation.timeoutMs,
        mutation.signal,
        4_096,
      );
      if (!report.ok) {
        return report;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        kind: "create-branch",
        name: name.value,
        previousRef: null,
        currentRef: start.value,
      } satisfies GitBranchMutation);
    },

    async switchBranch(request: GitSwitchBranchRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const name = validateGitRefName(request.name);
      if (!name.ok) {
        return name;
      }
      const previous =
        mutation.identity.branch.state === "observed" ? mutation.identity.branch.value : null;
      const report = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["switch", "--", name.value],
        mutation.timeoutMs,
        mutation.signal,
        4_096,
      );
      if (!report.ok) {
        return report;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        kind: "switch-branch",
        name: name.value,
        previousRef: previous,
        currentRef: name.value,
      } satisfies GitBranchMutation);
    },

    async deleteBranch(request: GitDeleteBranchRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const name = validateGitRefName(request.name);
      if (!name.ok) {
        return name;
      }
      if (
        mutation.identity.branch.state === "observed" &&
        mutation.identity.branch.value === name.value
      ) {
        return err({ code: "checked-out" });
      }
      const report = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["branch", "--delete", "--", name.value],
        mutation.timeoutMs,
        mutation.signal,
        4_096,
      );
      if (!report.ok) {
        return report;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        kind: "delete-branch",
        name: name.value,
        previousRef: name.value,
        currentRef: null,
      } satisfies GitBranchMutation);
    },

    async createWorktree(request: GitCreateWorktreeRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      if (request.branch !== undefined && request.detached === true) {
        return err({ code: "invalid-request", reason: "worktree-mode" });
      }
      const path = parseLocalPath(request.path);
      if (!path.ok) {
        return err({ code: "invalid-request", reason: path.error.code });
      }
      const start =
        request.startPoint === undefined
          ? mutation.identity.head.state === "observed"
            ? ok(mutation.identity.head.value)
            : err({ code: "invalid-request" as const, reason: "unborn" })
          : validateGitRevision(request.startPoint);
      if (!start.ok) {
        return start;
      }
      const branch =
        request.branch === undefined ? ok(undefined) : validateGitRefName(request.branch);
      if (!branch.ok) {
        return branch;
      }
      const subcommand =
        request.detached === true
          ? ["worktree", "add", "--detach", path.value, start.value]
          : branch.value === undefined
            ? ["worktree", "add", path.value, start.value]
            : ["worktree", "add", "-b", branch.value, path.value, start.value];
      const report = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        subcommand,
        mutation.timeoutMs,
        mutation.signal,
        4_096,
      );
      if (!report.ok) {
        return report;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      const listed = await listWorktreeAt(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        path.value,
        mutation.timeoutMs,
        mutation.signal,
        runGit,
      );
      if (!listed.ok) {
        return listed;
      }
      return ok({
        identity: identity.value,
        kind: "create-worktree",
        path: path.value,
        worktree: listed.value,
      } satisfies GitWorktreeMutation);
    },

    async removeWorktree(request: GitRemoveWorktreeRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const path = parseLocalPath(request.path);
      if (!path.ok) {
        return err({ code: "invalid-request", reason: path.error.code });
      }
      if (sameWorktreePath(mutation.identity.worktreeRoot, path.value)) {
        return err({ code: "invalid-request", reason: "main-worktree" });
      }
      const targetStatus = await statusAt(
        mutation.gitExecutable,
        path.value,
        mutation.timeoutMs,
        mutation.signal,
        runGit,
      );
      if (!targetStatus.ok) {
        return targetStatus;
      }
      if (worktreeHasBlockingChanges(targetStatus.value)) {
        return err({ code: "dirty-worktree" });
      }
      const report = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["worktree", "remove", path.value],
        mutation.timeoutMs,
        mutation.signal,
        4_096,
      );
      if (!report.ok) {
        return report;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        kind: "remove-worktree",
        path: path.value,
        worktree: null,
      } satisfies GitWorktreeMutation);
    },

    async createCheckpoint(request: GitCreateCheckpointRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      if (mutation.identity.headState === "unborn" || mutation.identity.head.state !== "observed") {
        return err({ code: "invalid-request", reason: "unborn" });
      }
      const includeUntracked = validateGitIncludeUntracked(request.includeUntracked);
      if (!includeUntracked.ok) {
        return includeUntracked;
      }
      const sessionId = validateGitCheckpointReference(request.sessionId);
      if (!sessionId.ok) {
        return sessionId;
      }
      const turnId = validateGitCheckpointReference(request.turnId);
      if (!turnId.ok) {
        return turnId;
      }
      const created = await snapshotCheckpoint(
        mutation,
        includeUntracked.value,
        sessionId.value,
        turnId.value,
        runGit,
      );
      if (!created.ok) {
        return created;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        checkpoint: created.value,
      } satisfies GitCheckpointSnapshot);
    },

    async listCheckpoints(request: GitListCheckpointsRequest) {
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const limits = validateGitCheckpointLimits(request.maxEntries);
      if (!limits.ok) {
        return limits;
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
      const listed = await runGit(
        parsed.value.gitExecutable,
        identity.value.worktreeRoot,
        ["for-each-ref", "--format=%(objectname)", GIT_CHECKPOINT_REF_PREFIX],
        parsed.value.timeoutMs,
        parsed.value.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!listed.ok) {
        return listed;
      }
      const ids = parseGitCheckpointRefs(listed.value.stdout.inlineText ?? "", limits.value);
      if (ids.state === "unavailable") {
        return err({ code: "failed", reason: ids.reason });
      }
      const checkpoints: GitCheckpointRecord[] = [];
      for (const id of ids.value) {
        const loaded = await loadCheckpointRecord(
          parsed.value.gitExecutable,
          identity.value.worktreeRoot,
          id,
          parsed.value.timeoutMs,
          parsed.value.signal,
          runGit,
        );
        if (!loaded.ok) {
          return loaded;
        }
        checkpoints.push(loaded.value);
      }
      return ok({
        identity: identity.value,
        checkpoints:
          ids.state === "truncated"
            ? { state: "truncated", value: checkpoints, omitted: ids.omitted }
            : { state: "observed", value: checkpoints },
      } satisfies GitCheckpointList);
    },

    async planRestore(request: GitRestoreCheckpointRequest) {
      return buildRestorePlan(request, loadIdentity, runGit, probeGit);
    },

    async restoreCheckpoint(request: GitRestoreCheckpointRequest) {
      const planned = await buildRestorePlan(request, loadIdentity, runGit, probeGit);
      if (!planned.ok) {
        return planned;
      }
      const plan = planned.value;
      const parsed = validateGitRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      if (plan.indexChanged) {
        const index = await runGit(
          parsed.value.gitExecutable,
          plan.identity.worktreeRoot,
          ["read-tree", plan.checkpoint.indexTree],
          parsed.value.timeoutMs,
          parsed.value.signal,
          4_096,
        );
        if (!index.ok) {
          return index;
        }
      }
      if (plan.worktreePaths.length > 0) {
        const restored = await runGit(
          parsed.value.gitExecutable,
          plan.identity.worktreeRoot,
          ["restore", `--source=${plan.checkpoint.worktreeTree}`, "--worktree", "--", "."],
          parsed.value.timeoutMs,
          parsed.value.signal,
          4_096,
        );
        if (!restored.ok) {
          return restored;
        }
      }
      for (const path of plan.untrackedRestores) {
        const blob = plan.checkpoint.includedUntracked.find((entry) => entry.path === path)?.blob;
        if (blob === undefined) {
          return err({ code: "failed", reason: "untracked-missing" });
        }
        const wrote = await restoreUntrackedBlob(
          parsed.value.gitExecutable,
          plan.identity.worktreeRoot,
          plan.identity.gitDir,
          path,
          blob,
          parsed.value.timeoutMs,
          parsed.value.signal,
          runGit,
        );
        if (!wrote.ok) {
          return wrote;
        }
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
      return ok({
        identity: identity.value,
        checkpoint: plan.checkpoint,
        restoredIndex: plan.indexChanged,
        restoredWorktree: plan.worktreePaths,
        restoredUntracked: plan.untrackedRestores,
      } satisfies GitRestoreResult);
    },

    async planCommits(request: GitPlanCommitsRequest) {
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
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
      const logged = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["log", "--no-color", `--max-count=${DEFAULT_GIT_LOG_COMMITS}`, `--format=${LOG_FORMAT}`],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      let subjects: readonly string[] = [];
      if (!logged.ok) {
        if (logged.error.code === "cancelled" || logged.error.code === "timed-out") {
          return logged;
        }
        if (mutation.identity.headState !== "unborn") {
          return logged;
        }
      } else {
        const parsed = parseGitLog(logged.value.stdout.inlineText ?? "", DEFAULT_GIT_LOG_COMMITS);
        if (parsed.state !== "unavailable") {
          subjects = parsed.value.map((commit) => commit.subject);
        }
      }
      return ok({
        identity: mutation.identity,
        plan: planGitCommits({
          identity: mutation.identity,
          entries: status.value.value,
          truncated: status.value.state === "truncated",
          subjects,
        }),
      } satisfies GitCommitPlanSnapshot);
    },

    async stage(request: GitStageRequest) {
      const paths = validateGitStagePaths(request.paths);
      if (!paths.ok) {
        return paths;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const added = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["add", "--", ...paths.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!added.ok) {
        return added;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({ identity: identity.value, paths: paths.value } satisfies GitIndexMutation);
    },

    async unstage(request: GitUnstageRequest) {
      const paths = validateGitPathspecs(request.paths);
      if (!paths.ok) {
        return paths;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const restored = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["restore", "--staged", "--", ...paths.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!restored.ok) {
        return restored;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({ identity: identity.value, paths: paths.value } satisfies GitIndexMutation);
    },

    async commit(request: GitCommitRequest) {
      const subject = validateGitCommitSubject(request.subject);
      if (!subject.ok) {
        return subject;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
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
      const secret = stagedSecretPath(status.value.value);
      if (secret !== null) {
        return err({ code: "secret-path", path: secret });
      }
      if (!indexHasStagedChanges(status.value.value)) {
        return err({ code: "empty-index" });
      }
      const committed = await runGitWithUserHooks(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["commit", "-m", subject.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!committed.ok) {
        return committed;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      if (identity.value.head.state !== "observed") {
        return err({ code: "failed", reason: "commit-head-unobserved" });
      }
      return ok({
        identity: identity.value,
        oid: identity.value.head.value,
        subject: subject.value,
      } satisfies GitCommitResult);
    },

    ...createGitRemoteOperations({ runGit, runGitWithUserHooks, loadIdentity }),
  };
}
