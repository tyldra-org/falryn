/**
 * Full-file writes and grouped multi-file mutation contracts (#281).
 *
 * Create requires absence; replace requires a file. Grouped plans declare
 * all-or-nothing or best-effort policy. Product tools remain later #61
 * children.
 */

import { type ContentDigest, contentDigest } from "./artifact.ts";
import type { LocalPath } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";
import type { ByteRange, NewlineStyle } from "./workspace-read.ts";
import {
  DEFAULT_MAX_AGGREGATE_READ_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  MAX_WORKSPACE_AGGREGATE_BYTES,
  MAX_WORKSPACE_FILE_BYTES,
} from "./workspace-read.ts";

export const DEFAULT_MAX_WRITE_TARGETS = 8;
export const HARD_MAX_WRITE_TARGETS = 32;
export const DEFAULT_MAX_WRITE_BYTES = DEFAULT_MAX_FILE_BYTES;
export const HARD_MAX_WRITE_BYTES = MAX_WORKSPACE_FILE_BYTES;
export const DEFAULT_MAX_WRITE_AGGREGATE_BYTES = DEFAULT_MAX_AGGREGATE_READ_BYTES;
export const HARD_MAX_WRITE_AGGREGATE_BYTES = MAX_WORKSPACE_AGGREGATE_BYTES;
export const MAX_WRITE_REVISION_LENGTH = 256;

export const WRITE_OPERATIONS = ["create", "replace"] as const;
export type WorkspaceWriteOperation = (typeof WRITE_OPERATIONS)[number];

export const WRITE_POLICIES = ["fail-before-effect", "best-effort"] as const;
export type WorkspaceWritePolicy = (typeof WRITE_POLICIES)[number];

export const WRITE_NEWLINE_POLICIES = ["lf", "crlf", "preserve"] as const;
export type WriteNewlinePolicy = (typeof WRITE_NEWLINE_POLICIES)[number];

export type WorkspaceWriteLimitName = "maxFileBytes" | "maxAggregateBytes" | "maxTargets";

export type WorkspaceWriteOverlapReason = "duplicate" | "case-collision";

export type WorkspaceWriteError =
  | WorkspacePathBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "not-found" }
  | { readonly code: "already-exists" }
  | { readonly code: "not-a-file" }
  | { readonly code: "digest-mismatch" }
  | { readonly code: "revision-mismatch" }
  | { readonly code: "cancelled" }
  | { readonly code: "too-many-targets" }
  | { readonly code: "malformed-plan" }
  | { readonly code: "malformed-kind" }
  | { readonly code: "malformed-text" }
  | { readonly code: "malformed-newline" }
  | { readonly code: "malformed-policy" }
  | { readonly code: "malformed-digest" }
  | { readonly code: "malformed-revision" }
  | { readonly code: "overlapping-targets"; readonly reason: WorkspaceWriteOverlapReason }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceWriteLimitName;
      readonly reason: "not-positive" | "not-safe-integer" | "above-hard-maximum";
    }
  | { readonly code: "oversized"; readonly byteLength: number }
  | { readonly code: "aggregate-limit" }
  | { readonly code: "plan-refused" }
  | { readonly code: "filesystem"; readonly reason: string };

export type WorkspaceWriteLimits = {
  readonly maxFileBytes: number;
  readonly maxAggregateBytes: number;
  readonly maxTargets: number;
};

export const DEFAULT_WRITE_LIMITS: WorkspaceWriteLimits = {
  maxFileBytes: DEFAULT_MAX_WRITE_BYTES,
  maxAggregateBytes: DEFAULT_MAX_WRITE_AGGREGATE_BYTES,
  maxTargets: DEFAULT_MAX_WRITE_TARGETS,
};

export type ParsedWorkspaceWriteTarget = {
  readonly index: number;
  readonly operation: WorkspaceWriteOperation;
  readonly path: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly newline: WriteNewlinePolicy;
  readonly expectedDigest: ContentDigest | null;
  readonly expectedRevision: string | null;
};

export type ParsedWorkspaceWritePlan = {
  readonly policy: WorkspaceWritePolicy;
  readonly limits: WorkspaceWriteLimits;
  readonly targets: readonly ParsedWorkspaceWriteTarget[];
};

export type WorkspaceWriteChangedRegion = {
  readonly kind: "byte";
  readonly range: ByteRange;
};

export type WorkspaceWriteApplied = {
  readonly index: number;
  readonly status: "applied";
  readonly operation: WorkspaceWriteOperation;
  readonly bound: BoundWorkspacePath;
  readonly digest: ContentDigest;
  readonly revision: string;
  readonly byteLength: number;
  readonly newline: NewlineStyle;
  readonly changedRegion: WorkspaceWriteChangedRegion;
};

export type WorkspaceWriteItemStatus = "skipped" | "failed" | "unscheduled" | "cancelled";

export type WorkspaceWriteRejected = {
  readonly index: number;
  readonly status: WorkspaceWriteItemStatus;
  readonly operation: WorkspaceWriteOperation;
  readonly requested: string;
  readonly resolved: LocalPath | null;
  readonly error: WorkspaceWriteError;
};

export type WorkspaceWriteItem = WorkspaceWriteApplied | WorkspaceWriteRejected;

export type WorkspaceWriteResult = {
  readonly policy: WorkspaceWritePolicy;
  readonly items: readonly WorkspaceWriteItem[];
};

const HARD_LIMITS: Readonly<Record<WorkspaceWriteLimitName, number>> = {
  maxFileBytes: HARD_MAX_WRITE_BYTES,
  maxAggregateBytes: HARD_MAX_WRITE_AGGREGATE_BYTES,
  maxTargets: HARD_MAX_WRITE_TARGETS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(
  value: unknown,
  field: WorkspaceWriteLimitName,
  fallback: number,
): Result<number, WorkspaceWriteError> {
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

function isWriteOperation(value: unknown): value is WorkspaceWriteOperation {
  return value === "create" || value === "replace";
}

function isWritePolicy(value: unknown): value is WorkspaceWritePolicy {
  return value === "fail-before-effect" || value === "best-effort";
}

function isNewlinePolicy(value: unknown): value is WriteNewlinePolicy {
  return value === "lf" || value === "crlf" || value === "preserve";
}

/** Encodes caller text under an explicit newline policy. */
export function encodeWriteText(text: string, newline: WriteNewlinePolicy): string {
  switch (newline) {
    case "preserve":
      return text;
    case "lf":
      return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    case "crlf":
      return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\r\n");
    default:
      return assertNever(newline, "unhandled write newline policy");
  }
}

function logicalKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function detectOverlap(paths: readonly string[]): WorkspaceWriteOverlapReason | null {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const logical = logicalKey(path);
    const folded = logical.toLowerCase();
    const previous = seen.get(folded);
    if (previous === undefined) {
      seen.set(folded, logical);
      continue;
    }
    return previous === logical ? "duplicate" : "case-collision";
  }
  return null;
}

function parseTarget(
  value: unknown,
  index: number,
  maxFileBytes: number,
): Result<ParsedWorkspaceWriteTarget, WorkspaceWriteError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  if (!isWriteOperation(value.kind)) {
    return err({ code: "malformed-kind" });
  }
  if (typeof value.path !== "string") {
    return err({ code: "malformed", reason: "path-not-a-string" });
  }
  if (value.path.length === 0) {
    return err({ code: "malformed", reason: "path-empty" });
  }
  if (value.path.includes("\0")) {
    return err({ code: "malformed", reason: "path-illegal-character" });
  }
  if (typeof value.text !== "string" || value.text.includes("\0")) {
    return err({ code: "malformed-text" });
  }
  const newline = value.newline === undefined ? "preserve" : value.newline;
  if (!isNewlinePolicy(newline)) {
    return err({ code: "malformed-newline" });
  }
  let expectedDigest: ContentDigest | null = null;
  if (value.expectedDigest !== undefined) {
    const parsed = contentDigest.parse(value.expectedDigest);
    if (!parsed.ok) {
      return err({ code: "malformed-digest" });
    }
    expectedDigest = parsed.value;
  }
  let expectedRevision: string | null = null;
  if (value.expectedRevision !== undefined) {
    if (
      typeof value.expectedRevision !== "string" ||
      value.expectedRevision.length === 0 ||
      value.expectedRevision.length > MAX_WRITE_REVISION_LENGTH ||
      value.expectedRevision.includes("\0")
    ) {
      return err({ code: "malformed-revision" });
    }
    expectedRevision = value.expectedRevision;
  }
  const encoded = encodeWriteText(value.text, newline);
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.byteLength > maxFileBytes) {
    return err({ code: "oversized", byteLength: bytes.byteLength });
  }
  return ok({
    index,
    operation: value.kind,
    path: value.path,
    text: encoded,
    bytes,
    newline,
    expectedDigest,
    expectedRevision,
  });
}

export function parseWorkspaceWritePlan(
  value: unknown,
): Result<ParsedWorkspaceWritePlan, WorkspaceWriteError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  const policy = value.policy === undefined ? "fail-before-effect" : value.policy;
  if (!isWritePolicy(policy)) {
    return err({ code: "malformed-policy" });
  }
  const maxFileBytes = parseLimit(
    value.maxFileBytes,
    "maxFileBytes",
    DEFAULT_WRITE_LIMITS.maxFileBytes,
  );
  if (!maxFileBytes.ok) {
    return maxFileBytes;
  }
  const maxAggregateBytes = parseLimit(
    value.maxAggregateBytes,
    "maxAggregateBytes",
    DEFAULT_WRITE_LIMITS.maxAggregateBytes,
  );
  if (!maxAggregateBytes.ok) {
    return maxAggregateBytes;
  }
  const maxTargets = parseLimit(value.maxTargets, "maxTargets", DEFAULT_WRITE_LIMITS.maxTargets);
  if (!maxTargets.ok) {
    return maxTargets;
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    return err({ code: "malformed-plan" });
  }
  if (value.targets.length > maxTargets.value) {
    return err({ code: "too-many-targets" });
  }
  const targets: ParsedWorkspaceWriteTarget[] = [];
  let aggregate = 0;
  for (const [index, candidate] of value.targets.entries()) {
    const parsed = parseTarget(candidate, index, maxFileBytes.value);
    if (!parsed.ok) {
      return parsed;
    }
    aggregate += parsed.value.bytes.byteLength;
    if (aggregate > maxAggregateBytes.value) {
      return err({ code: "aggregate-limit" });
    }
    targets.push(parsed.value);
  }
  const overlap = detectOverlap(targets.map((target) => target.path));
  if (overlap !== null) {
    return err({ code: "overlapping-targets", reason: overlap });
  }
  return ok({
    policy,
    limits: {
      maxFileBytes: maxFileBytes.value,
      maxAggregateBytes: maxAggregateBytes.value,
      maxTargets: maxTargets.value,
    },
    targets,
  });
}

export function wholeFileChangedRegion(byteLength: number): WorkspaceWriteChangedRegion {
  return { kind: "byte", range: { start: 0, end: byteLength } };
}

export function describeWorkspaceWriteError(error: WorkspaceWriteError): string {
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
    case "already-exists":
      return "already-exists";
    case "not-a-file":
      return "not-a-file";
    case "digest-mismatch":
      return "digest-mismatch";
    case "revision-mismatch":
      return "revision-mismatch";
    case "cancelled":
      return "cancelled";
    case "too-many-targets":
      return "too-many-targets";
    case "malformed-plan":
      return "malformed-plan";
    case "malformed-kind":
      return "malformed-kind";
    case "malformed-text":
      return "malformed-text";
    case "malformed-newline":
      return "malformed-newline";
    case "malformed-policy":
      return "malformed-policy";
    case "malformed-digest":
      return "malformed-digest";
    case "malformed-revision":
      return "malformed-revision";
    case "overlapping-targets":
      return `overlapping-targets:${error.reason}`;
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "oversized":
      return `oversized:${error.byteLength}`;
    case "aggregate-limit":
      return "aggregate-limit";
    case "plan-refused":
      return "plan-refused";
    case "filesystem":
      return `filesystem:${error.reason}`;
    default:
      return assertNever(error, "unhandled workspace write error");
  }
}
