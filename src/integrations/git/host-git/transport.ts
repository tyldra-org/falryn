import { createSystemClock, type DurationMs } from "../../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../../domain/foundation/result.ts";
import {
  GIT_OBSERVATION_ENVIRONMENT,
  type GitError,
  type GitIdentity,
  gitArgv,
  gitFailureFromCapture,
  gitFailureFromStop,
  gitUserHookArgv,
  parseGitVersion,
  parseRevParsePaths,
  parseStatusPorcelainV2,
} from "../../../domain/git/index.ts";
import {
  MAX_COMMAND_OUTPUT_BYTES,
  type ProcessCaptureRequest,
} from "../../../domain/process/index.ts";
import { parseLocalPath } from "../../../domain/workspace/index.ts";
import type { GitRunner, HostGitOptions } from "./contracts.ts";
import {
  captureErrorToGit,
  detectOperation,
  remoteField,
  resolveOperation,
  sparseField,
} from "./support.ts";

export function createGitExecution(options: HostGitOptions) {
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

  const probeGitWithUserHooks: GitRunner = async (
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
      argv: gitUserHookArgv(subcommand),
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

  const runGitWithUserHooks: GitRunner = async (...args) => {
    const probed = await probeGitWithUserHooks(...args);
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

  return { probeGit, runGit, runGitWithUserHooks, loadIdentity };
}
