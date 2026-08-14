/**
 * Bounded workspace text-search contracts (#63).
 *
 * Literal and regex queries, glob filters, and match/walk/depth limits live
 * here. Supervised `rg` and the TypeScript fallback stay in application.
 * Indexes, patches, and product tools remain later #61 children.
 */

import { type DurationMs, duration } from "./clock.ts";
import type { LocalPath } from "./filesystem.ts";
import { parseLocalPath } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  type CompiledGlob,
  compileGlobPattern,
  compileGlobPatterns,
  type GlobPatternErrorReason,
  HARD_MAX_WALK_DEPTH,
  HARD_MAX_WALK_ENTRIES,
  type WorkspaceDiscoveryError,
} from "./workspace-glob.ts";
import type { WorkspaceListingError } from "./workspace-listing.ts";
import { DEFAULT_MAX_WALK_DEPTH, DEFAULT_MAX_WALK_ENTRIES } from "./workspace-listing.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";

export const MAX_SEARCH_QUERY_LENGTH = 256;
export const MAX_SEARCH_LINE_EXCERPT = 256;
export const MAX_SEARCH_CONTEXT = 3;
export const DEFAULT_MAX_SEARCH_MATCHES = 100;
export const HARD_MAX_SEARCH_MATCHES = 1_000;
export const DEFAULT_SEARCH_TIMEOUT_MS = duration(10_000);
export const DEFAULT_SEARCH_FILE_BYTES = 1_048_576;

export type WorkspaceSearchKind = "literal" | "regex";
export type WorkspaceSearchEngine = "ripgrep" | "typescript-fallback";
export type WorkspaceSearchFallbackReason = "unavailable" | "spawn-failed";
export type WorkspaceSearchLimitName =
  | "maxMatches"
  | "maxWalkEntries"
  | "maxDepth"
  | "context"
  | "timeoutMs"
  | "maxFileBytes";
export type SearchTruncation = "match-limit" | "entry-limit" | "depth-limit" | "output-limit";

export type WorkspaceSearchError =
  | WorkspaceListingError
  | { readonly code: "malformed-glob"; readonly reason: GlobPatternErrorReason }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceSearchLimitName;
      readonly reason: "not-safe-integer" | "not-positive" | "above-hard-maximum";
    }
  | {
      readonly code: "malformed-query";
      readonly reason: "empty" | "too-long" | "illegal-character";
    }
  | { readonly code: "malformed-regex" }
  | { readonly code: "malformed-kind" }
  | { readonly code: "malformed-executable" }
  | { readonly code: "timed-out" };

export type CompiledSearchQuery = {
  readonly kind: WorkspaceSearchKind;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly regex: RegExp | null;
};

export type WorkspaceSearchMatch = {
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
};

export type WorkspaceSearchLimits = {
  readonly maxMatches: number;
  readonly maxWalkEntries: number;
  readonly maxDepth: number;
  readonly context: number;
  readonly timeoutMs: DurationMs;
  readonly maxFileBytes: number;
  readonly includeHidden: boolean;
  readonly includeBinary: boolean;
  readonly caseSensitive: boolean;
};

export type ParsedWorkspaceSearch = WorkspaceSearchLimits & {
  readonly start: string;
  readonly query: CompiledSearchQuery;
  readonly include: readonly CompiledGlob[];
  readonly exclude: readonly CompiledGlob[];
  readonly ripgrepExecutable: LocalPath | null;
};

export type WorkspaceSearchResult = {
  readonly start: BoundWorkspacePath;
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly truncated: boolean;
  readonly truncation: SearchTruncation | null;
  readonly engine: WorkspaceSearchEngine;
  readonly fallbackReason: WorkspaceSearchFallbackReason | null;
};

export const DEFAULT_SEARCH_LIMITS: WorkspaceSearchLimits = {
  maxMatches: DEFAULT_MAX_SEARCH_MATCHES,
  maxWalkEntries: DEFAULT_MAX_WALK_ENTRIES,
  maxDepth: DEFAULT_MAX_WALK_DEPTH,
  context: 0,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  maxFileBytes: DEFAULT_SEARCH_FILE_BYTES,
  includeHidden: false,
  includeBinary: false,
  caseSensitive: true,
};

const HARD_LIMITS: Readonly<Record<WorkspaceSearchLimitName, number>> = {
  maxMatches: HARD_MAX_SEARCH_MATCHES,
  maxWalkEntries: HARD_MAX_WALK_ENTRIES,
  maxDepth: HARD_MAX_WALK_DEPTH,
  context: MAX_SEARCH_CONTEXT,
  timeoutMs: 60_000,
  maxFileBytes: DEFAULT_SEARCH_FILE_BYTES,
};

const KINDS: readonly WorkspaceSearchKind[] = ["literal", "regex"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(
  value: unknown,
  field: WorkspaceSearchLimitName,
  fallback: number,
  minimum = 1,
): Result<number, WorkspaceSearchError> {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) {
    return err({ code: "malformed-limit", field, reason: "not-safe-integer" });
  }
  if (resolved < minimum) {
    return err({ code: "malformed-limit", field, reason: "not-positive" });
  }
  if (resolved > HARD_LIMITS[field]) {
    return err({ code: "malformed-limit", field, reason: "above-hard-maximum" });
  }
  return ok(resolved);
}

export function compileSearchQuery(
  query: unknown,
  kind: WorkspaceSearchKind,
  caseSensitive: boolean,
): Result<CompiledSearchQuery, WorkspaceSearchError> {
  if (typeof query !== "string") {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length === 0) {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return err({ code: "malformed-query", reason: "too-long" });
  }
  if (query.includes("\0")) {
    return err({ code: "malformed-query", reason: "illegal-character" });
  }
  if (kind === "literal") {
    return ok({ kind, query, caseSensitive, regex: null });
  }
  try {
    return ok({
      kind,
      query,
      caseSensitive,
      regex: new RegExp(query, caseSensitive ? "" : "i"),
    });
  } catch {
    return err({ code: "malformed-regex" });
  }
}

export function excerptLine(text: string): string {
  return text.length <= MAX_SEARCH_LINE_EXCERPT ? text : text.slice(0, MAX_SEARCH_LINE_EXCERPT);
}

export function findMatchColumn(line: string, compiled: CompiledSearchQuery): number | null {
  if (compiled.kind === "literal") {
    const haystack = compiled.caseSensitive ? line : line.toLowerCase();
    const needle = compiled.caseSensitive ? compiled.query : compiled.query.toLowerCase();
    const index = haystack.indexOf(needle);
    return index < 0 ? null : index + 1;
  }
  const regex = compiled.regex;
  if (regex === null) {
    return null;
  }
  regex.lastIndex = 0;
  const matched = regex.exec(line);
  return matched === null || matched.index < 0 ? null : matched.index + 1;
}

export function compareSearchMatches(
  left: WorkspaceSearchMatch,
  right: WorkspaceSearchMatch,
): number {
  const byPath = left.logical.localeCompare(right.logical);
  if (byPath !== 0) {
    return byPath;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function asSearchGlobError(error: WorkspaceDiscoveryError): WorkspaceSearchError {
  switch (error.code) {
    case "malformed-kinds":
      return { code: "malformed-glob", reason: "not-an-array" };
    case "malformed-glob":
    case "malformed-limit":
    case "malformed":
    case "escaped":
    case "absolute-unscoped":
    case "symlink-escape":
    case "not-found":
    case "not-a-directory":
    case "cancelled":
    case "filesystem":
      return error;
    default:
      return assertNever(error, "unhandled glob compile error");
  }
}

export function parseWorkspaceSearchRequest(
  value: unknown,
): Result<ParsedWorkspaceSearch, WorkspaceSearchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-glob", reason: "not-an-object" });
  }
  if (value.kind !== undefined) {
    if (typeof value.kind !== "string" || !KINDS.includes(value.kind as WorkspaceSearchKind)) {
      return err({ code: "malformed-kind" });
    }
  }
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.includeBinary !== undefined && typeof value.includeBinary !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.start !== undefined && typeof value.start !== "string") {
    return err({ code: "malformed", reason: "path-not-a-string" });
  }

  const kind = (value.kind as WorkspaceSearchKind | undefined) ?? "literal";
  const caseSensitive = value.caseSensitive ?? DEFAULT_SEARCH_LIMITS.caseSensitive;
  const query = compileSearchQuery(value.query, kind, caseSensitive);
  if (!query.ok) {
    return query;
  }

  const include =
    value.include === undefined ? compileGlobPattern("*") : compileGlobPatterns(value.include);
  if (!include.ok) {
    return err(asSearchGlobError(include.error));
  }
  const includeGlobs = Array.isArray(include.value) ? include.value : [include.value];
  if (includeGlobs.length === 0) {
    return err({ code: "malformed-glob", reason: "empty-include" });
  }
  const exclude = value.exclude === undefined ? ok([]) : compileGlobPatterns(value.exclude);
  if (!exclude.ok) {
    return err(asSearchGlobError(exclude.error));
  }
  // Keep include+exclude globs inside CommandRunnerPort's 32-argument cap
  // after ripgrep's fixed flags (`--json`, `--no-config`, bounds, `-e`, path).
  if (includeGlobs.length + exclude.value.length > 6) {
    return err({ code: "malformed-glob", reason: "too-many" });
  }

  const maxMatches = parseLimit(value.maxMatches, "maxMatches", DEFAULT_SEARCH_LIMITS.maxMatches);
  if (!maxMatches.ok) {
    return maxMatches;
  }
  const maxWalkEntries = parseLimit(
    value.maxWalkEntries,
    "maxWalkEntries",
    DEFAULT_SEARCH_LIMITS.maxWalkEntries,
  );
  if (!maxWalkEntries.ok) {
    return maxWalkEntries;
  }
  const maxDepth = parseLimit(value.maxDepth, "maxDepth", DEFAULT_SEARCH_LIMITS.maxDepth);
  if (!maxDepth.ok) {
    return maxDepth;
  }
  const context = parseLimit(value.context, "context", DEFAULT_SEARCH_LIMITS.context, 0);
  if (!context.ok) {
    return context;
  }
  const timeoutMs = parseLimit(value.timeoutMs, "timeoutMs", DEFAULT_SEARCH_LIMITS.timeoutMs);
  if (!timeoutMs.ok) {
    return timeoutMs;
  }
  const maxFileBytes = parseLimit(
    value.maxFileBytes,
    "maxFileBytes",
    DEFAULT_SEARCH_LIMITS.maxFileBytes,
  );
  if (!maxFileBytes.ok) {
    return maxFileBytes;
  }

  let ripgrepExecutable: LocalPath | null = null;
  if (value.ripgrepExecutable !== undefined && value.ripgrepExecutable !== null) {
    const parsed = parseLocalPath(value.ripgrepExecutable);
    if (!parsed.ok) {
      return err({ code: "malformed-executable" });
    }
    ripgrepExecutable = parsed.value;
  }

  return ok({
    start: value.start === undefined ? "." : value.start,
    query: query.value,
    include: includeGlobs,
    exclude: exclude.value,
    ripgrepExecutable,
    maxMatches: maxMatches.value,
    maxWalkEntries: maxWalkEntries.value,
    maxDepth: maxDepth.value,
    context: context.value,
    timeoutMs: duration(timeoutMs.value),
    maxFileBytes: maxFileBytes.value,
    includeHidden: value.includeHidden ?? DEFAULT_SEARCH_LIMITS.includeHidden,
    includeBinary: value.includeBinary ?? DEFAULT_SEARCH_LIMITS.includeBinary,
    caseSensitive,
  });
}

export function describeWorkspaceSearchError(error: WorkspaceSearchError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.reason}`;
    case "escaped":
      return "escaped";
    case "absolute-unscoped":
      return "absolute-unscoped";
    case "symlink-escape":
      return "symlink-escape";
    case "not-found":
      return "not-found";
    case "not-a-directory":
      return "not-a-directory";
    case "cancelled":
      return "cancelled";
    case "filesystem":
      return `filesystem:${error.reason}`;
    case "malformed-glob":
      return `malformed-glob:${error.reason}`;
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "malformed-query":
      return `malformed-query:${error.reason}`;
    case "malformed-regex":
      return "malformed-regex";
    case "malformed-kind":
      return "malformed-kind";
    case "malformed-executable":
      return "malformed-executable";
    case "timed-out":
      return "timed-out";
    default:
      return assertNever(error, "unhandled workspace search error");
  }
}
