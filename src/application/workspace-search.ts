/**
 * Bounded workspace text search (#63).
 *
 * Prefers supervised ripgrep through {@link CommandRunnerPort} when an absolute
 * executable is supplied. Otherwise, and when spawn fails, walks and reads
 * through {@link FileSystemPort}. The TypeScript path never invokes `rg`.
 * Indexes, patches, and product tools remain later #61 children.
 */

import {
  type BoundWorkspacePath,
  type CommandRunnerPort,
  compareSearchMatches,
  excerptLine,
  type FileSystemPort,
  findMatchColumn,
  globMatchesAny,
  isBinaryText,
  isExcludedByGlobs,
  isInside,
  type LocalPath,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_OUTPUT_BYTES,
  type ParsedWorkspaceSearch,
  parseWorkspaceSearchRequest,
  resolveLocalPath,
  splitLines,
  type WorkspaceSearchError,
  type WorkspaceSearchFallbackReason,
  type WorkspaceSearchMatch,
  type WorkspaceSearchResult,
} from "../domain/index.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";
import { createWorkspacePathBinder } from "./workspace-path.ts";

export type WorkspaceTextSearch = {
  search(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceSearchResult }
    | { readonly ok: false; readonly error: WorkspaceSearchError }
  >;
};

export type WorkspaceTextSearchOptions = {
  readonly fileSystem: FileSystemPort;
  readonly commands: CommandRunnerPort;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createWorkspaceTextSearch(
  options: WorkspaceTextSearchOptions,
): WorkspaceTextSearch {
  const listing = createWorkspaceListing(options.fileSystem);
  const binder = createWorkspacePathBinder(options.fileSystem);
  return {
    async search(root, request, signal) {
      const parsed = parseWorkspaceSearchRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      if (parsed.value.ripgrepExecutable !== null) {
        const fromRipgrep = await searchWithRipgrep(
          options.commands,
          binder,
          root,
          parsed.value,
          signal,
        );
        if (fromRipgrep.ok) {
          return fromRipgrep;
        }
        if (
          fromRipgrep.error.code === "filesystem" &&
          fromRipgrep.error.reason === "spawn-failed"
        ) {
          return searchWithTypeScript(
            options.fileSystem,
            listing,
            root,
            parsed.value,
            "spawn-failed",
            signal,
          );
        }
        return fromRipgrep;
      }
      return searchWithTypeScript(
        options.fileSystem,
        listing,
        root,
        parsed.value,
        "unavailable",
        signal,
      );
    },
  };
}

async function bindStart(
  binder: ReturnType<typeof createWorkspacePathBinder>,
  root: LocalPath,
  start: string,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceSearchError }
> {
  const bound = await binder.bind(root, start, signal);
  if (bound.ok) {
    return bound;
  }
  if (bound.error.code === "filesystem") {
    return { ok: false, error: { code: "filesystem", reason: bound.error.error.code } };
  }
  return { ok: false, error: bound.error };
}

async function searchWithRipgrep(
  commands: CommandRunnerPort,
  binder: ReturnType<typeof createWorkspacePathBinder>,
  root: LocalPath,
  parsed: ParsedWorkspaceSearch,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceSearchResult }
  | { readonly ok: false; readonly error: WorkspaceSearchError }
> {
  const bound = await bindStart(binder, root, parsed.start, signal);
  if (!bound.ok) {
    return bound;
  }
  const executable = parsed.ripgrepExecutable;
  if (executable === null) {
    return { ok: false, error: { code: "malformed-executable" } };
  }
  const argv = ripgrepArgv(parsed, bound.value.resolved);
  if (argv === null) {
    return { ok: false, error: { code: "filesystem", reason: "too-many-arguments" } };
  }
  const outcome = await commands.run({
    executable,
    argv,
    environment: {},
    timeoutMs: parsed.timeoutMs,
    maxOutputBytes: Math.min(MAX_COMMAND_OUTPUT_BYTES, Math.max(parsed.maxMatches * 512, 1_024)),
    signal,
  });
  switch (outcome.kind) {
    case "cancelled":
      return { ok: false, error: { code: "cancelled" } };
    case "timed-out":
      return { ok: false, error: { code: "timed-out" } };
    case "output-exceeded":
      return {
        ok: true,
        value: emptyRipgrep(bound.value, "output-limit"),
      };
    case "spawn-failed":
      return { ok: false, error: { code: "filesystem", reason: "spawn-failed" } };
    case "exited": {
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
        return { ok: false, error: { code: "malformed-regex" } };
      }
      const matches = parseRipgrepJson(outcome.stdout, root);
      matches.sort(compareSearchMatches);
      const truncated = matches.length > parsed.maxMatches;
      return {
        ok: true,
        value: {
          start: bound.value,
          matches: truncated ? matches.slice(0, parsed.maxMatches) : matches,
          truncated,
          truncation: truncated ? "match-limit" : null,
          engine: "ripgrep",
          fallbackReason: null,
        },
      };
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

async function searchWithTypeScript(
  fileSystem: FileSystemPort,
  listing: ReturnType<typeof createWorkspaceListing>,
  root: LocalPath,
  parsed: ParsedWorkspaceSearch,
  fallbackReason: WorkspaceSearchFallbackReason,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceSearchResult }
  | { readonly ok: false; readonly error: WorkspaceSearchError }
> {
  const walked = await listing.walk(
    root,
    parsed.start,
    {
      includeHidden: parsed.includeHidden,
      maxEntries: parsed.maxWalkEntries,
      maxDepth: parsed.maxDepth,
    },
    signal,
  );
  if (!walked.ok) {
    return walked;
  }

  const matches: WorkspaceSearchMatch[] = [];
  for (const entry of walked.value.entries) {
    if (isAborted(signal)) {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (entry.kind !== "file") {
      continue;
    }
    if (isExcludedByGlobs(entry.logical, entry.kind, parsed.exclude)) {
      continue;
    }
    if (!globMatchesAny(entry.logical, entry.kind, parsed.include)) {
      continue;
    }
    const read = await fileSystem.readText(entry.resolved, parsed.maxFileBytes, signal);
    if (!read.ok) {
      if (read.error.code === "cancelled") {
        return { ok: false, error: { code: "cancelled" } };
      }
      continue;
    }
    if (!parsed.includeBinary && isBinaryText(read.value)) {
      continue;
    }
    const lines = splitLines(read.value);
    for (const [index, line] of lines.entries()) {
      const column = findMatchColumn(line, parsed.query);
      if (column === null) {
        continue;
      }
      const before = lines
        .slice(Math.max(0, index - parsed.context), index)
        .map((text) => excerptLine(text));
      const after = lines
        .slice(index + 1, index + 1 + parsed.context)
        .map((text) => excerptLine(text));
      matches.push({
        logical: entry.logical,
        resolved: entry.resolved,
        line: index + 1,
        column,
        text: excerptLine(line),
        before,
        after,
      });
      if (matches.length >= parsed.maxMatches) {
        matches.sort(compareSearchMatches);
        return {
          ok: true,
          value: {
            start: walked.value.start,
            matches,
            truncated: true,
            truncation: "match-limit",
            engine: "typescript-fallback",
            fallbackReason,
          },
        };
      }
    }
  }

  matches.sort(compareSearchMatches);
  const truncated = walked.value.truncated;
  return {
    ok: true,
    value: {
      start: walked.value.start,
      matches,
      truncated,
      truncation: truncated ? walked.value.truncation : null,
      engine: "typescript-fallback",
      fallbackReason,
    },
  };
}

function emptyRipgrep(
  start: BoundWorkspacePath,
  truncation: "output-limit",
): WorkspaceSearchResult {
  return {
    start,
    matches: [],
    truncated: true,
    truncation,
    engine: "ripgrep",
    fallbackReason: null,
  };
}

function ripgrepArgv(
  parsed: ParsedWorkspaceSearch,
  searchRoot: LocalPath,
): readonly string[] | null {
  const argv: string[] = [
    "--json",
    "--no-config",
    "--no-ignore",
    "--no-ignore-vcs",
    "--color",
    "never",
  ];
  if (parsed.query.kind === "literal") {
    argv.push("-F");
  }
  if (!parsed.caseSensitive) {
    argv.push("-i");
  }
  if (parsed.includeHidden) {
    argv.push("--hidden");
  }
  if (parsed.includeBinary) {
    argv.push("--binary");
  }
  if (parsed.context > 0) {
    argv.push("-C", String(parsed.context));
  }
  argv.push("--max-count", String(parsed.maxMatches));
  argv.push("--max-filesize", String(parsed.maxFileBytes));
  for (const glob of parsed.include) {
    argv.push("--glob", glob.pattern);
  }
  for (const glob of parsed.exclude) {
    argv.push("--glob", `!${glob.pattern}`);
  }
  argv.push("-e", parsed.query.query, "--", searchRoot);
  return argv.length > MAX_COMMAND_ARGUMENTS ? null : argv;
}

function parseRipgrepJson(stdout: string, root: LocalPath): WorkspaceSearchMatch[] {
  const matches: WorkspaceSearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const match = ripgrepMatchFromEvent(parsed, root);
    if (match !== null) {
      matches.push(match);
    }
  }
  return matches;
}

function ripgrepMatchFromEvent(event: unknown, root: LocalPath): WorkspaceSearchMatch | null {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  const record = event as {
    readonly type?: unknown;
    readonly data?: {
      readonly path?: { readonly text?: unknown };
      readonly lines?: { readonly text?: unknown };
      readonly line_number?: unknown;
      readonly submatches?: readonly { readonly start?: unknown }[];
    };
  };
  if (record.type !== "match" || record.data === undefined) {
    return null;
  }
  const pathText = record.data.path?.text;
  const lineText = record.data.lines?.text;
  const lineNumber = record.data.line_number;
  if (
    typeof pathText !== "string" ||
    typeof lineText !== "string" ||
    typeof lineNumber !== "number"
  ) {
    return null;
  }
  const resolved = resolveLocalPath(root, pathText.replace(/\\/g, "/"));
  if (!resolved.ok || !isInside(root, resolved.value)) {
    return null;
  }
  const logical =
    resolved.value === root
      ? ""
      : resolved.value.slice(root.endsWith("/") ? root.length : root.length + 1);
  const start = record.data.submatches?.[0]?.start;
  const column = typeof start === "number" && start >= 0 ? start + 1 : 1;
  return {
    logical,
    resolved: resolved.value,
    line: lineNumber,
    column,
    text: excerptLine(lineText.replace(/\n$/u, "")),
    before: [],
    after: [],
  };
}
