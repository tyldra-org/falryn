import type {
  GitBlameLine,
  GitCheckpointUntracked,
  GitField,
  GitHeadState,
  GitLogCommit,
  GitRemote,
  GitStatusEntry,
  GitWorktreeRecord,
} from "./contracts.ts";
import { redactGitRemoteUrl } from "./remote.ts";

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

export function asOid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

export function asHeadState(value: unknown): GitHeadState | null {
  if (value === "branch" || value === "detached" || value === "unborn") {
    return value;
  }
  return null;
}

export function asIncludedUntracked(value: unknown): readonly GitCheckpointUntracked[] | null {
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
