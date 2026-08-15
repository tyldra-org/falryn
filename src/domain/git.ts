/**
 * Read-only Git observation contracts (#76).
 *
 * Discovery, status, diff, log, and blame live here as typed snapshots. The
 * host adapter runs `git` through ProcessCapturePort. This module never
 * stages, commits, fetches, or rewrites history, and it does not register a
 * product tool.
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

export type GitPort = {
  discover(request: GitDiscoverRequest): Promise<Result<GitIdentity, GitError>>;
  status(request: GitStatusRequest): Promise<Result<GitStatusSnapshot, GitError>>;
  diff(request: GitDiffRequest): Promise<Result<GitDiffSnapshot, GitError>>;
  log(request: GitLogRequest): Promise<Result<GitLogSnapshot, GitError>>;
  blame(request: GitBlameRequest): Promise<Result<GitBlameSnapshot, GitError>>;
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
