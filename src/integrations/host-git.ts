/**
 * Host Git observation adapter (#76).
 *
 * Runs `git` through ProcessCapturePort with a complete supplied environment
 * and a structured argv. Stderr is classified into typed failures and then
 * dropped. This adapter never stages, commits, or rewrites history.
 */

import {
  type ClockPort,
  createSystemClock,
  type DurationMs,
  GIT_OBSERVATION_ENVIRONMENT,
  type GitBlameRequest,
  type GitBlameSnapshot,
  type GitDiffRequest,
  type GitDiffScope,
  type GitDiffSnapshot,
  type GitDiscoverRequest,
  type GitError,
  type GitField,
  type GitIdentity,
  type GitLogRequest,
  type GitLogSnapshot,
  type GitOperationState,
  type GitPort,
  type GitRemote,
  type GitStatusEntry,
  type GitStatusRequest,
  type GitStatusSnapshot,
  gitArgv,
  gitFailureFromCapture,
  gitFailureFromStop,
  type LocalPath,
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  parseGitBlame,
  parseGitLog,
  parseGitRemotes,
  parseGitVersion,
  parseLocalPath,
  parseRevParsePaths,
  parseStatusPorcelainV2,
  validateGitBlameRequest,
  validateGitDiffLimits,
  validateGitLogLimits,
  validateGitRequest,
  validateGitStatusLimits,
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
  ) => {
    const request: ProcessCaptureRequest = {
      executable,
      argv: gitArgv(subcommand),
      environment: GIT_OBSERVATION_ENVIRONMENT,
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
