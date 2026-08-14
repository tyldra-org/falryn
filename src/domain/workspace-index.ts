/**
 * Bounded structural and derived-index query contracts (#64).
 *
 * Queries run against one atomic index generation. Freshness is decided by
 * comparing stored revisions to the workspace. Index builders, Tree-sitter,
 * embeddings, and product tools remain later work.
 */

import type { LocalPath } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  type CompiledGlob,
  compileGlobPattern,
  compileGlobPatterns,
  type GlobPatternErrorReason,
  type WorkspaceDiscoveryError,
} from "./workspace-glob.ts";
import type { WorkspaceListingError } from "./workspace-listing.ts";

export const MAX_INDEX_QUERY_LENGTH = 256;
export const MAX_INDEX_EXCERPT = 256;
export const MAX_INDEX_GENERATION_ID_LENGTH = 64;
export const DEFAULT_MAX_INDEX_MATCHES = 100;
export const HARD_MAX_INDEX_MATCHES = 1_000;
export const MAX_INDEX_GLOBS = 8;

export const INDEX_QUERY_KINDS = ["structural", "lexical"] as const;
export type IndexQueryKind = (typeof INDEX_QUERY_KINDS)[number];

export const INDEX_RECORD_KINDS = ["symbol", "heading", "chunk"] as const;
export type IndexRecordKind = (typeof INDEX_RECORD_KINDS)[number];

export const INDEX_LIFECYCLES = [
  "absent",
  "inventorying",
  "building",
  "ready",
  "updating",
  "stale",
  "degraded",
  "corrupt",
  "unavailable",
] as const;
export type IndexLifecycle = (typeof INDEX_LIFECYCLES)[number];

export const INDEX_FRESHNESS = ["current", "stale", "unverified"] as const;
export type IndexHitFreshness = (typeof INDEX_FRESHNESS)[number];

export type WorkspaceIndexLimitName = "maxMatches";
export type IndexTruncation = "match-limit";

export type WorkspaceIndexError =
  | WorkspaceListingError
  | { readonly code: "malformed-glob"; readonly reason: GlobPatternErrorReason }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceIndexLimitName;
      readonly reason: "not-safe-integer" | "not-positive" | "above-hard-maximum";
    }
  | {
      readonly code: "malformed-query";
      readonly reason: "empty" | "too-long" | "illegal-character";
    }
  | { readonly code: "malformed-kind" }
  | { readonly code: "malformed-record-kind" }
  | { readonly code: "index-absent" }
  | { readonly code: "index-not-ready"; readonly lifecycle: IndexLifecycle }
  | { readonly code: "index-corrupt" }
  | { readonly code: "unavailable" };

export type WorkspaceIndexRecord = {
  readonly logical: string;
  readonly kind: IndexRecordKind;
  readonly name: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly revision: string;
};

export type WorkspaceIndexGeneration = {
  readonly id: string;
  readonly schema: string;
  readonly lifecycle: IndexLifecycle;
  readonly records: readonly WorkspaceIndexRecord[];
};

export type WorkspaceIndexHit = {
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly kind: IndexRecordKind;
  readonly name: string;
  readonly excerpt: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly freshness: IndexHitFreshness;
  readonly generation: string;
};

export type ParsedWorkspaceIndexQuery = {
  readonly query: string;
  readonly kind: IndexQueryKind;
  readonly recordKinds: readonly IndexRecordKind[];
  readonly include: readonly CompiledGlob[];
  readonly exclude: readonly CompiledGlob[];
  readonly maxMatches: number;
  readonly includeHidden: boolean;
  readonly caseSensitive: boolean;
};

export type WorkspaceIndexQueryResult = {
  readonly generation: string;
  readonly schema: string;
  readonly lifecycle: IndexLifecycle;
  readonly hits: readonly WorkspaceIndexHit[];
  readonly truncated: boolean;
  readonly truncation: IndexTruncation | null;
};

export type WorkspaceIndexPort = {
  snapshot(
    root: LocalPath,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceIndexGeneration }
    | { readonly ok: false; readonly error: WorkspaceIndexError }
  >;
};

export const DEFAULT_INDEX_LIMITS = {
  maxMatches: DEFAULT_MAX_INDEX_MATCHES,
  includeHidden: false,
  caseSensitive: true,
} as const;

const QUERYABLE: ReadonlySet<IndexLifecycle> = new Set(["ready", "updating", "stale", "degraded"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asIndexGlobError(error: WorkspaceDiscoveryError): WorkspaceIndexError {
  switch (error.code) {
    case "malformed-kinds":
      return { code: "malformed-glob", reason: "not-an-array" };
    case "malformed-limit":
      return { code: "malformed-glob", reason: "too-many" };
    case "malformed-glob":
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

function parseLimit(value: unknown, fallback: number): Result<number, WorkspaceIndexError> {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) {
    return err({ code: "malformed-limit", field: "maxMatches", reason: "not-safe-integer" });
  }
  if (resolved < 1) {
    return err({ code: "malformed-limit", field: "maxMatches", reason: "not-positive" });
  }
  if (resolved > HARD_MAX_INDEX_MATCHES) {
    return err({
      code: "malformed-limit",
      field: "maxMatches",
      reason: "above-hard-maximum",
    });
  }
  return ok(resolved);
}

function parseRecordKinds(value: unknown): Result<readonly IndexRecordKind[], WorkspaceIndexError> {
  if (value === undefined) {
    return ok(INDEX_RECORD_KINDS);
  }
  if (!Array.isArray(value) || value.length === 0) {
    return err({ code: "malformed-record-kind" });
  }
  const kinds: IndexRecordKind[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !INDEX_RECORD_KINDS.includes(item as IndexRecordKind)) {
      return err({ code: "malformed-record-kind" });
    }
    kinds.push(item as IndexRecordKind);
  }
  return ok(kinds);
}

export function excerptIndexText(text: string): string {
  return text.length <= MAX_INDEX_EXCERPT ? text : text.slice(0, MAX_INDEX_EXCERPT);
}

export function indexLifecycleQueryable(lifecycle: IndexLifecycle): boolean {
  return QUERYABLE.has(lifecycle);
}

export function lifecycleQueryError(lifecycle: IndexLifecycle): WorkspaceIndexError {
  switch (lifecycle) {
    case "absent":
      return { code: "index-absent" };
    case "corrupt":
      return { code: "index-corrupt" };
    case "unavailable":
      return { code: "unavailable" };
    case "inventorying":
    case "building":
      return { code: "index-not-ready", lifecycle };
    case "ready":
    case "updating":
    case "stale":
    case "degraded":
      return { code: "unavailable" };
    default:
      return assertNever(lifecycle, "unhandled index lifecycle");
  }
}

export function recordMatchesQuery(
  record: WorkspaceIndexRecord,
  parsed: ParsedWorkspaceIndexQuery,
): boolean {
  if (!parsed.recordKinds.includes(record.kind)) {
    return false;
  }
  const haystack = parsed.kind === "structural" ? record.name : record.text;
  const needle = parsed.query;
  if (parsed.caseSensitive) {
    return haystack.includes(needle);
  }
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function compareIndexHits(left: WorkspaceIndexHit, right: WorkspaceIndexHit): number {
  const byPath = left.logical.localeCompare(right.logical);
  if (byPath !== 0) {
    return byPath;
  }
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  return left.name.localeCompare(right.name);
}

export function parseWorkspaceIndexQuery(
  value: unknown,
): Result<ParsedWorkspaceIndexQuery, WorkspaceIndexError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-glob", reason: "not-an-object" });
  }
  if (value.kind !== undefined) {
    if (
      typeof value.kind !== "string" ||
      !INDEX_QUERY_KINDS.includes(value.kind as IndexQueryKind)
    ) {
      return err({ code: "malformed-kind" });
    }
  }
  if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return err({ code: "malformed-glob", reason: "invalid-flag" });
  }

  const query = value.query;
  if (typeof query !== "string") {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length === 0) {
    return err({ code: "malformed-query", reason: "empty" });
  }
  if (query.length > MAX_INDEX_QUERY_LENGTH) {
    return err({ code: "malformed-query", reason: "too-long" });
  }
  if (query.includes("\0")) {
    return err({ code: "malformed-query", reason: "illegal-character" });
  }

  const recordKinds = parseRecordKinds(value.recordKinds);
  if (!recordKinds.ok) {
    return recordKinds;
  }

  const include =
    value.include === undefined ? compileGlobPattern("*") : compileGlobPatterns(value.include);
  if (!include.ok) {
    return err(asIndexGlobError(include.error));
  }
  const includeGlobs = Array.isArray(include.value) ? include.value : [include.value];
  if (includeGlobs.length === 0) {
    return err({ code: "malformed-glob", reason: "empty-include" });
  }
  const exclude = value.exclude === undefined ? ok([]) : compileGlobPatterns(value.exclude);
  if (!exclude.ok) {
    return err(asIndexGlobError(exclude.error));
  }
  if (includeGlobs.length + exclude.value.length > MAX_INDEX_GLOBS) {
    return err({ code: "malformed-glob", reason: "too-many" });
  }

  const maxMatches = parseLimit(value.maxMatches, DEFAULT_INDEX_LIMITS.maxMatches);
  if (!maxMatches.ok) {
    return maxMatches;
  }

  return ok({
    query,
    kind: (value.kind as IndexQueryKind | undefined) ?? "structural",
    recordKinds: recordKinds.value,
    include: includeGlobs,
    exclude: exclude.value,
    maxMatches: maxMatches.value,
    includeHidden: value.includeHidden ?? DEFAULT_INDEX_LIMITS.includeHidden,
    caseSensitive: value.caseSensitive ?? DEFAULT_INDEX_LIMITS.caseSensitive,
  });
}

export function createInMemoryWorkspaceIndex(
  generation: WorkspaceIndexGeneration,
): WorkspaceIndexPort {
  return {
    async snapshot(_root, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      return ok(generation);
    },
  };
}

export function describeWorkspaceIndexError(error: WorkspaceIndexError): string {
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
    case "malformed-kind":
      return "malformed-kind";
    case "malformed-record-kind":
      return "malformed-record-kind";
    case "index-absent":
      return "index-absent";
    case "index-not-ready":
      return `index-not-ready:${error.lifecycle}`;
    case "index-corrupt":
      return "index-corrupt";
    case "unavailable":
      return "unavailable";
    default:
      return assertNever(error, "unhandled workspace index error");
  }
}
