/**
 * Host Git observation, safe branch/worktree, checkpoint, and commit-plan
 * adapter (#76/#78/#79/#80).
 *
 * Runs `git` through ProcessCapturePort with a complete supplied environment
 * and a structured argv. Stderr is classified into typed failures and then
 * dropped. This adapter never stages or commits on the user index, force-updates,
 * stashes, or rewrites history.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  type ClockPort,
  createSystemClock,
  DEFAULT_GIT_LOG_COMMITS,
  type DurationMs,
  formatGitCheckpointMessage,
  GIT_CHECKPOINT_REF_PREFIX,
  GIT_OBSERVATION_ENVIRONMENT,
  type GitBlameRequest,
  type GitBlameSnapshot,
  type GitBranchMutation,
  type GitCheckpointList,
  type GitCheckpointRecord,
  type GitCheckpointSnapshot,
  type GitCommitPlanSnapshot,
  type GitCreateBranchRequest,
  type GitCreateCheckpointRequest,
  type GitCreateWorktreeRequest,
  type GitDeleteBranchRequest,
  type GitDiffRequest,
  type GitDiffScope,
  type GitDiffSnapshot,
  type GitDiscoverRequest,
  type GitError,
  type GitField,
  type GitIdentity,
  type GitListCheckpointsRequest,
  type GitListWorktreesRequest,
  type GitLogRequest,
  type GitLogSnapshot,
  type GitOperationState,
  type GitPlanCommitsRequest,
  type GitPort,
  type GitRemote,
  type GitRemoveWorktreeRequest,
  type GitRestoreCheckpointRequest,
  type GitRestorePlan,
  type GitRestoreResult,
  type GitStatusEntry,
  type GitStatusRequest,
  type GitStatusSnapshot,
  type GitSwitchBranchRequest,
  type GitWorktreeList,
  type GitWorktreeMutation,
  type GitWorktreeRecord,
  gitArgv,
  gitCheckpointRef,
  gitFailureFromCapture,
  gitFailureFromStop,
  type LocalPath,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_GIT_WORKTREES,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  parseGitBlame,
  parseGitCheckpointMessage,
  parseGitCheckpointRefs,
  parseGitLog,
  parseGitRemotes,
  parseGitVersion,
  parseGitWorktrees,
  parseLocalPath,
  parseRevParsePaths,
  parseStatusPorcelainV2,
  planGitCommits,
  refuseUnsafeGitIdentity,
  validateGitBlameRequest,
  validateGitCheckpointLimits,
  validateGitCheckpointReference,
  validateGitDiffLimits,
  validateGitIncludeUntracked,
  validateGitLogLimits,
  validateGitOid,
  validateGitRefName,
  validateGitRequest,
  validateGitRevision,
  validateGitStatusLimits,
  validateGitWorktreeLimits,
  worktreeHasBlockingChanges,
} from "../domain/index.ts";
import { err, ok, type Result } from "../domain/result.ts";

export type HostGitOptions = {
  readonly capture: ProcessCapturePort;
  readonly clock?: ClockPort;
};

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

type GitRunner = (
  executable: string,
  cwd: string,
  subcommand: readonly string[],
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  extraEnv?: Readonly<Record<string, string>> | undefined,
) => Promise<Result<ProcessCaptureReport, GitError>>;

export function createHostGitPort(options: HostGitOptions): GitPort {
  const clock = options.clock ?? createSystemClock();

  const probeGit: GitRunner = async (
    executable,
    cwd,
    subcommand,
    timeoutMs,
    signal,
    maxOutputBytes,
    extraEnv,
  ) => {
    const request: ProcessCaptureRequest = {
      executable,
      argv: gitArgv(subcommand),
      environment:
        extraEnv === undefined
          ? GIT_OBSERVATION_ENVIRONMENT
          : { ...GIT_OBSERVATION_ENVIRONMENT, ...extraEnv },
      cwd,
      timeoutMs,
      maxOutputBytes,
      maxInlineBytes: maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    };
    const captured = await options.capture.run(request);
    if (!captured.ok) {
      return err(captureErrorToGit(captured.error.code));
    }
    const stopped = gitFailureFromStop(captured.value.stop);
    if (stopped !== null) {
      return err(stopped);
    }
    return ok(captured.value);
  };

  const runGit: GitRunner = async (...args) => {
    const probed = await probeGit(...args);
    if (!probed.ok) {
      return probed;
    }
    const failed = gitFailureFromCapture(probed.value);
    if (failed !== null) {
      return err(failed);
    }
    return probed;
  };

  const loadIdentity = async (
    gitExecutable: string,
    startPath: string,
    timeoutMs: DurationMs,
    signal: AbortSignal | undefined,
  ): Promise<Result<GitIdentity, GitError>> => {
    const inside = await runGit(
      gitExecutable,
      startPath,
      ["rev-parse", "--is-inside-work-tree"],
      timeoutMs,
      signal,
      256,
    );
    if (!inside.ok) {
      return inside;
    }
    if (inside.value.stdout.inlineText?.trim() !== "true") {
      return err({ code: "not-a-repository" });
    }

    const paths = await runGit(
      gitExecutable,
      startPath,
      [
        "rev-parse",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "--show-superproject-working-tree",
      ],
      timeoutMs,
      signal,
      8_192,
    );
    if (!paths.ok) {
      return paths;
    }
    const parsedPaths = parseRevParsePaths(paths.value.stdout.inlineText ?? "");
    const worktree = parseLocalPath(parsedPaths.worktreeRoot ?? "");
    if (!worktree.ok) {
      return err({ code: "failed", reason: "worktree-unparsed" });
    }
    const cwd = worktree.value;

    const [statusReport, versionReport, remoteReport, sparseReport, operation] = await Promise.all([
      runGit(
        gitExecutable,
        cwd,
        ["status", "--porcelain=v2", "--branch", "-z"],
        timeoutMs,
        signal,
        MAX_COMMAND_OUTPUT_BYTES,
      ),
      runGit(gitExecutable, cwd, ["--version"], timeoutMs, signal, 256),
      probeGit(gitExecutable, cwd, ["remote", "-v"], timeoutMs, signal, 8_192),
      probeGit(
        gitExecutable,
        cwd,
        ["config", "--bool", "core.sparseCheckout"],
        timeoutMs,
        signal,
        64,
      ),
      detectOperation(gitExecutable, cwd, timeoutMs, signal, probeGit),
    ]);
    if (!statusReport.ok) {
      return statusReport;
    }
    const branch = parseStatusPorcelainV2(
      statusReport.value.stdout.inlineText ?? "",
      MAX_COMMAND_OUTPUT_BYTES,
    );
    return ok({
      worktreeRoot: cwd,
      gitDir: parsedPaths.gitDir ?? ".git",
      commonDir: parsedPaths.commonDir ?? parsedPaths.gitDir ?? ".git",
      head: branch.head,
      headState: branch.headState,
      branch: branch.branch,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      operation: resolveOperation(operation, branch.entries),
      superproject:
        parsedPaths.superproject === null
          ? { state: "unavailable", reason: "no-superproject" }
          : { state: "observed", value: parsedPaths.superproject },
      sparseCheckout: sparseField(sparseReport),
      gitVersion: versionReport.ok
        ? parseGitVersion(versionReport.value.stdout.inlineText ?? "")
        : { state: "unavailable", reason: "version-unavailable" },
      remotes: remoteField(remoteReport),
      observedAt: clock.now(),
    });
  };

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
  };
}

function diffArgv(scope: GitDiffScope, path: string | undefined): readonly string[] {
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

function captureErrorToGit(code: string): GitError {
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

async function prepareMutation(
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

async function reloadIdentity(prepared: PreparedMutation): Promise<Result<GitIdentity, GitError>> {
  return prepared.loadIdentity(
    prepared.gitExecutable,
    prepared.startPath,
    prepared.timeoutMs,
    prepared.signal,
  );
}

async function snapshotCheckpoint(
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

async function loadCheckpointRecord(
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

async function buildRestorePlan(
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

async function restoreUntrackedBlob(
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

async function listWorktreeAt(
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

async function statusAt(
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

function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\/+$/, "").replace(/^\/private\//, "/");
  return normalize(left) === normalize(right);
}

function remoteField(
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

function sparseField(report: Result<ProcessCaptureReport, GitError>): GitField<boolean> {
  if (!report.ok) {
    return { state: "observed", value: false };
  }
  return { state: "observed", value: report.value.stdout.inlineText?.trim() === "true" };
}

async function detectOperation(
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

function resolveOperation(
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
