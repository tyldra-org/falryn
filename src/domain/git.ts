/**
 * Git observation, safe branch/worktree, checkpoint, commit-plan, and
 * stage/commit/sync contracts (#76/#78/#79/#80/#283).
 *
 * Discovery, status, diff, log, and blame are typed snapshots. Branch create,
 * switch, and delete plus worktree add/list/remove are history-safe mutations.
 * Checkpoints snapshot index/worktree trees under `refs/falryn/checkpoints/`
 * and restore only after a preview. `planCommits` returns grouping advice.
 * Stage, unstage, commit, fetch, pull, push, and sync mutate only through
 * explicit `GitPort` methods and never force-update, rebase, stash, or rewrite
 * history. The host adapter runs `git` through ProcessCapturePort. This module
 * does not register a product tool.
 */

import type { LocalPath } from "./filesystem.ts";
import { parseLocalPath } from "./filesystem.ts";
import {
  DEFAULT_GIT_BLAME_LINES,
  DEFAULT_GIT_CHECKPOINTS,
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_LOG_COMMITS,
  DEFAULT_GIT_REMOTE_NAME,
  DEFAULT_GIT_STATUS_ENTRIES,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_GIT_WORKTREES,
  GIT_CHECKPOINT_REF_PREFIX,
  GIT_CHECKPOINT_VERSION,
  GIT_DIFF_SCOPES,
  GIT_INVOCATION_PREFIX,
  GIT_USER_HOOK_INVOCATION_PREFIX,
  type GitBlameLine,
  type GitCheckpointRecord,
  type GitCheckpointUntracked,
  type GitDiffScope,
  type GitError,
  type GitField,
  type GitHeadState,
  type GitIdentity,
  type GitLogCommit,
  type GitRemote,
  type GitRequestBase,
  type GitStatusEntry,
  type GitWorktreeRecord,
  MAX_GIT_BLAME_LINES,
  MAX_GIT_CHECKPOINT_REFERENCE_LENGTH,
  MAX_GIT_CHECKPOINT_UNTRACKED,
  MAX_GIT_CHECKPOINTS,
  MAX_GIT_COMMIT_SUBJECT_LENGTH,
  MAX_GIT_DIFF_BYTES,
  MAX_GIT_LOG_COMMITS,
  MAX_GIT_REF_NAME_LENGTH,
  MAX_GIT_REMOTE_URL_LENGTH,
  MAX_GIT_STAGE_PATHS,
  MAX_GIT_STATUS_ENTRIES,
  MAX_GIT_WORKTREES,
  type ParsedGitRequest,
} from "./git/contracts.ts";
import { isAbsoluteCommandPath } from "./process.ts";
import type { ProcessCaptureReport, ProcessCaptureStop } from "./process-capture.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export * from "./git/contracts.ts";

export function gitArgv(subcommand: readonly string[]): readonly string[] {
  return [...GIT_INVOCATION_PREFIX, ...subcommand];
}

export function gitUserHookArgv(subcommand: readonly string[]): readonly string[] {
  return [...GIT_USER_HOOK_INVOCATION_PREFIX, ...subcommand];
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

export function isSecretPath(path: string): boolean {
  const base = gitBasename(path).toLowerCase();
  const lower = path.toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base === "credentials" || base === "credentials.json") {
    return true;
  }
  if (base === "id_rsa" || base === "id_ed25519" || base.endsWith(".pem")) {
    return true;
  }
  if (lower.includes("secret") || lower.includes("password")) {
    return true;
  }
  return lower.includes("/.env");
}

export function validateGitPathspecs(
  paths: readonly string[] | undefined,
): Result<readonly string[], GitError> {
  if (paths === undefined || paths.length === 0) {
    return err({ code: "invalid-request", reason: "paths" });
  }
  if (paths.length > MAX_GIT_STAGE_PATHS) {
    return err({ code: "invalid-request", reason: "paths" });
  }
  const unique = new Set<string>();
  const validated: string[] = [];
  for (const path of paths) {
    const parsed = validateGitRelPath(path);
    if (!parsed.ok) {
      return parsed;
    }
    if (unique.has(parsed.value)) {
      return err({ code: "invalid-request", reason: "paths" });
    }
    unique.add(parsed.value);
    validated.push(parsed.value);
  }
  return ok(validated);
}

export function validateGitStagePaths(
  paths: readonly string[] | undefined,
): Result<readonly string[], GitError> {
  const parsed = validateGitPathspecs(paths);
  if (!parsed.ok) {
    return parsed;
  }
  for (const path of parsed.value) {
    if (isSecretPath(path)) {
      return err({ code: "secret-path", path });
    }
  }
  return parsed;
}

export function validateGitCommitSubject(subject: string): Result<string, GitError> {
  const trimmed = subject.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_GIT_COMMIT_SUBJECT_LENGTH ||
    trimmed.includes("\0") ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    /#\d/.test(trimmed) ||
    /\bv?\d+\.\d+/.test(trimmed)
  ) {
    return err({ code: "invalid-request", reason: "subject" });
  }
  return ok(trimmed);
}

export function validateGitRemoteName(remote: string | undefined): Result<string, GitError> {
  const name = remote ?? DEFAULT_GIT_REMOTE_NAME;
  const parsed = validateGitRefName(name);
  if (!parsed.ok) {
    return err({ code: "invalid-request", reason: "remote" });
  }
  return ok(parsed.value);
}

export function indexHasStagedChanges(entries: readonly GitStatusEntry[]): boolean {
  return entries.some(isStagedEntry);
}

export function stagedSecretPath(entries: readonly GitStatusEntry[]): string | null {
  for (const entry of entries) {
    if (isStagedEntry(entry) && isSecretPath(entry.path)) {
      return entry.path;
    }
  }
  return null;
}

function isStagedEntry(entry: GitStatusEntry): boolean {
  if (entry.kind === "untracked" || entry.kind === "ignored") {
    return false;
  }
  return entry.indexStatus !== "." && entry.indexStatus !== " " && entry.indexStatus !== "?";
}

function gitBasename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
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
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("terminal prompts disabled") ||
    text.includes("permission denied (publickey)") ||
    text.includes("could not read password")
  ) {
    return { code: "authentication" };
  }
  if (
    text.includes("hook declined") ||
    text.includes("hook failed") ||
    (text.includes("pre-commit") && text.includes("fail"))
  ) {
    return { code: "hook-failed", reason: `exit-${exitCode}` };
  }
  if (
    text.includes("gpg failed") ||
    text.includes("signing failed") ||
    text.includes("secret key not available")
  ) {
    return { code: "signing-failed", reason: `exit-${exitCode}` };
  }
  if (
    text.includes("non-fast-forward") ||
    text.includes("not possible to fast-forward") ||
    text.includes("cannot fast-forward")
  ) {
    return { code: "non-fast-forward" };
  }
  if (text.includes("nothing to commit")) {
    return { code: "empty-index" };
  }
  if (
    text.includes("no upstream") ||
    text.includes("no tracking information") ||
    text.includes("has no upstream branch")
  ) {
    return { code: "no-upstream" };
  }
  if (text.includes("[rejected]") || text.includes("failed to push")) {
    return { code: "rejected", reason: `exit-${exitCode}` };
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
