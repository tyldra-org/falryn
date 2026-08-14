/**
 * Bounded path and glob discovery contracts (#62).
 *
 * Matching is gitignore/ripgrep-glob shaped: `*` and `?` stay inside one
 * segment, `**` crosses directories, a trailing `/` selects directories, and a
 * pattern without `/` may match at any depth. Listing/walk stay #280. Content
 * search, `rg`, indexes, patches, and product tools remain later #61 children.
 */

import type { FileKind } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type {
  WalkTruncation,
  WorkspaceEntry,
  WorkspaceEntryFailure,
  WorkspaceListingError,
} from "./workspace-listing.ts";
import { DEFAULT_MAX_WALK_DEPTH, DEFAULT_MAX_WALK_ENTRIES } from "./workspace-listing.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";

export const MAX_GLOB_PATTERN_LENGTH = 256;
export const MAX_GLOB_PATTERNS = 64;
export const DEFAULT_MAX_DISCOVERY_MATCHES = 1_000;
export const HARD_MAX_DISCOVERY_MATCHES = 10_000;
export const HARD_MAX_WALK_ENTRIES = DEFAULT_MAX_WALK_ENTRIES;
export const HARD_MAX_WALK_DEPTH = 64;

export type GlobPatternErrorReason =
  | "not-a-string"
  | "not-an-object"
  | "not-an-array"
  | "empty"
  | "empty-include"
  | "too-long"
  | "too-many"
  | "illegal-character"
  | "unclosed-class"
  | "empty-class"
  | "empty-segment"
  | "invalid-flag";

export type WorkspaceDiscoveryKind = "all" | "file" | "directory";

export type WorkspaceDiscoveryLimitName = "maxMatches" | "maxWalkEntries" | "maxDepth";

export type DiscoveryTruncation = WalkTruncation | "match-limit";

export type WorkspaceDiscoveryError =
  | WorkspaceListingError
  | { readonly code: "malformed-glob"; readonly reason: GlobPatternErrorReason }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceDiscoveryLimitName;
      readonly reason: "not-safe-integer" | "not-positive" | "above-hard-maximum";
    }
  | { readonly code: "malformed-kinds" };

export type CompiledGlob = {
  readonly pattern: string;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
};

export type WorkspaceDiscoveryLimits = {
  readonly maxMatches: number;
  readonly maxWalkEntries: number;
  readonly maxDepth: number;
  readonly includeHidden: boolean;
  readonly kinds: WorkspaceDiscoveryKind;
};

export type ParsedWorkspaceDiscovery = WorkspaceDiscoveryLimits & {
  readonly start: string;
  readonly include: readonly CompiledGlob[];
  readonly exclude: readonly CompiledGlob[];
};

export type WorkspaceDiscoveryResult = {
  readonly start: BoundWorkspacePath;
  readonly matches: readonly WorkspaceEntry[];
  readonly failures: readonly WorkspaceEntryFailure[];
  readonly truncated: boolean;
  readonly truncation: DiscoveryTruncation | null;
};

export const DEFAULT_DISCOVERY_LIMITS: WorkspaceDiscoveryLimits = {
  maxMatches: DEFAULT_MAX_DISCOVERY_MATCHES,
  maxWalkEntries: DEFAULT_MAX_WALK_ENTRIES,
  maxDepth: DEFAULT_MAX_WALK_DEPTH,
  includeHidden: false,
  kinds: "all",
};

const HARD_LIMITS: Readonly<Record<WorkspaceDiscoveryLimitName, number>> = {
  maxMatches: HARD_MAX_DISCOVERY_MATCHES,
  maxWalkEntries: HARD_MAX_WALK_ENTRIES,
  maxDepth: HARD_MAX_WALK_DEPTH,
};

const KINDS: readonly WorkspaceDiscoveryKind[] = ["all", "file", "directory"];

function globError(reason: GlobPatternErrorReason): WorkspaceDiscoveryError {
  return { code: "malformed-glob", reason };
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function translateGlobBody(body: string): Result<string, WorkspaceDiscoveryError> {
  let index = 0;
  let out = "";
  while (index < body.length) {
    const current = body[index];
    if (current === "*") {
      if (body[index + 1] === "*") {
        const after = body[index + 2];
        if (after === undefined) {
          out += ".*";
          index += 2;
          continue;
        }
        if (after === "/") {
          out += "(?:.*/)?";
          index += 3;
          continue;
        }
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (current === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (current === "[") {
      const close = body.indexOf("]", index + 1);
      if (close < 0) {
        return err(globError("unclosed-class"));
      }
      let inner = body.slice(index + 1, close);
      if (inner.includes("/")) {
        return err(globError("illegal-character"));
      }
      if (inner.length === 0) {
        return err(globError("empty-class"));
      }
      let negated = false;
      if (inner.startsWith("!") || inner.startsWith("^")) {
        negated = true;
        inner = inner.slice(1);
        if (inner.length === 0) {
          return err(globError("empty-class"));
        }
      }
      const escaped = inner.replace(/[\\\]^-]/g, "\\$&");
      out += negated ? `[^/${escaped}]` : `[${escaped}]`;
      index = close + 1;
      continue;
    }
    if (current === "/") {
      if (body.startsWith("/**", index) && body[index + 3] === undefined) {
        out += "(?:/.*)?";
        index = body.length;
        continue;
      }
      if (body[index + 1] === "/" || body[index + 1] === undefined) {
        return err(globError("empty-segment"));
      }
      out += "/";
      index += 1;
      continue;
    }
    out += escapeRegexChar(current ?? "");
    index += 1;
  }
  return ok(out);
}

export function compileGlobPattern(value: unknown): Result<CompiledGlob, WorkspaceDiscoveryError> {
  if (typeof value !== "string") {
    return err(globError("not-a-string"));
  }
  if (value.length === 0) {
    return err(globError("empty"));
  }
  if (value.length > MAX_GLOB_PATTERN_LENGTH) {
    return err(globError("too-long"));
  }
  if (value.includes("\0")) {
    return err(globError("illegal-character"));
  }

  const directoryOnly = value.endsWith("/");
  let body = directoryOnly ? value.slice(0, -1) : value;
  const hasSlash = value.includes("/");
  if (body.startsWith("/")) {
    body = body.slice(1);
  }
  if (body.length === 0) {
    return ok({
      pattern: value,
      directoryOnly,
      regex: /^$/,
    });
  }

  const translated = translateGlobBody(body);
  if (!translated.ok) {
    return translated;
  }
  const anchored = value.startsWith("/") || hasSlash;
  const prefix = anchored ? "^" : "(?:^|.*/)";
  return ok({
    pattern: value,
    directoryOnly,
    regex: new RegExp(`${prefix}${translated.value}$`),
  });
}

export function compileGlobPatterns(
  value: unknown,
): Result<readonly CompiledGlob[], WorkspaceDiscoveryError> {
  if (!Array.isArray(value)) {
    return err(globError("not-an-array"));
  }
  if (value.length > MAX_GLOB_PATTERNS) {
    return err(globError("too-many"));
  }
  const compiled: CompiledGlob[] = [];
  for (const pattern of value) {
    const next = compileGlobPattern(pattern);
    if (!next.ok) {
      return next;
    }
    compiled.push(next.value);
  }
  return ok(compiled);
}

export function matchGlob(logical: string, glob: CompiledGlob, kind: FileKind): boolean {
  if (glob.directoryOnly && kind !== "directory") {
    return false;
  }
  return glob.regex.test(logical);
}

function parentLogicals(logical: string): readonly string[] {
  if (logical.length === 0) {
    return [];
  }
  const parts = logical.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

export function globMatchesAny(
  logical: string,
  kind: FileKind,
  globs: readonly CompiledGlob[],
): boolean {
  return globs.some((glob) => matchGlob(logical, glob, kind));
}

export function isExcludedByGlobs(
  logical: string,
  kind: FileKind,
  excludes: readonly CompiledGlob[],
): boolean {
  if (excludes.length === 0) {
    return false;
  }
  if (globMatchesAny(logical, kind, excludes)) {
    return true;
  }
  return parentLogicals(logical).some((parent) => globMatchesAny(parent, "directory", excludes));
}

export function kindAdmitted(kind: FileKind, filter: WorkspaceDiscoveryKind): boolean {
  switch (filter) {
    case "all":
      return true;
    case "file":
      return kind === "file";
    case "directory":
      return kind === "directory";
    default:
      return assertNever(filter, "unhandled workspace discovery kind");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(
  value: unknown,
  field: WorkspaceDiscoveryLimitName,
  fallback: number,
): Result<number, WorkspaceDiscoveryError> {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) {
    return err({ code: "malformed-limit", field, reason: "not-safe-integer" });
  }
  if (resolved < 1) {
    return err({ code: "malformed-limit", field, reason: "not-positive" });
  }
  if (resolved > HARD_LIMITS[field]) {
    return err({ code: "malformed-limit", field, reason: "above-hard-maximum" });
  }
  return ok(resolved);
}

export function parseWorkspaceDiscoveryRequest(
  value: unknown,
): Result<ParsedWorkspaceDiscovery, WorkspaceDiscoveryError> {
  if (!isRecord(value)) {
    return err(globError("not-an-object"));
  }
  const include = compileGlobPatterns(value.include);
  if (!include.ok) {
    return include;
  }
  if (include.value.length === 0) {
    return err(globError("empty-include"));
  }
  const exclude = value.exclude === undefined ? ok([]) : compileGlobPatterns(value.exclude);
  if (!exclude.ok) {
    return exclude;
  }
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return err(globError("invalid-flag"));
  }
  if (value.kinds !== undefined) {
    if (typeof value.kinds !== "string" || !KINDS.includes(value.kinds as WorkspaceDiscoveryKind)) {
      return err({ code: "malformed-kinds" });
    }
  }
  if (value.start !== undefined && typeof value.start !== "string") {
    return err({ code: "malformed", reason: "path-not-a-string" });
  }

  const maxMatches = parseLimit(
    value.maxMatches,
    "maxMatches",
    DEFAULT_DISCOVERY_LIMITS.maxMatches,
  );
  if (!maxMatches.ok) {
    return maxMatches;
  }
  const maxWalkEntries = parseLimit(
    value.maxWalkEntries,
    "maxWalkEntries",
    DEFAULT_DISCOVERY_LIMITS.maxWalkEntries,
  );
  if (!maxWalkEntries.ok) {
    return maxWalkEntries;
  }
  const maxDepth = parseLimit(value.maxDepth, "maxDepth", DEFAULT_DISCOVERY_LIMITS.maxDepth);
  if (!maxDepth.ok) {
    return maxDepth;
  }

  return ok({
    start: value.start === undefined ? "." : value.start,
    include: include.value,
    exclude: exclude.value,
    includeHidden: value.includeHidden ?? DEFAULT_DISCOVERY_LIMITS.includeHidden,
    kinds: (value.kinds as WorkspaceDiscoveryKind | undefined) ?? DEFAULT_DISCOVERY_LIMITS.kinds,
    maxMatches: maxMatches.value,
    maxWalkEntries: maxWalkEntries.value,
    maxDepth: maxDepth.value,
  });
}

export function describeWorkspaceDiscoveryError(error: WorkspaceDiscoveryError): string {
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
    case "malformed-kinds":
      return "malformed-kinds";
    default:
      return assertNever(error, "unhandled workspace discovery error");
  }
}
