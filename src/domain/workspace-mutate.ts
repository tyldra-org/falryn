/**
 * Workspace move, copy, trash, and remove contracts (#282).
 *
 * Recursion and cross-device copy-verify-remove live in application. The port
 * only renames one entry or copies one non-directory. Dedicated rollback and
 * product tools remain later #61 children.
 */

import type { LocalPath } from "./filesystem.ts";
import { isInside } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  DEFAULT_MAX_WALK_DEPTH,
  DEFAULT_MAX_WALK_ENTRIES,
  type WorkspaceListingError,
} from "./workspace-listing.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";

export const DEFAULT_MAX_MUTATION_ENTRIES = DEFAULT_MAX_WALK_ENTRIES;
export const HARD_MAX_MUTATION_ENTRIES = DEFAULT_MAX_WALK_ENTRIES;
export const DEFAULT_MAX_MUTATION_DEPTH = DEFAULT_MAX_WALK_DEPTH;
export const HARD_MAX_MUTATION_DEPTH = 64;

export const MUTATION_OPERATIONS = ["move", "copy", "remove", "trash"] as const;
export type WorkspaceMutationOperation = (typeof MUTATION_OPERATIONS)[number];

export const OVERWRITE_POLICIES = ["error", "replace", "merge"] as const;
export type OverwritePolicy = (typeof OVERWRITE_POLICIES)[number];

export const MUTATION_TRANSPORTS = ["rename", "copy-verify-remove"] as const;
export type MutationTransport = (typeof MUTATION_TRANSPORTS)[number];

export type WorkspaceMutationLimitName = "maxEntries" | "maxDepth";

export type WorkspaceMutationError =
  | WorkspaceListingError
  | { readonly code: "already-exists" }
  | { readonly code: "not-a-file" }
  | { readonly code: "not-empty" }
  | { readonly code: "into-self" }
  | { readonly code: "too-broad"; readonly truncation: "entry-limit" | "depth-limit" }
  | { readonly code: "unsupported-trash" }
  | { readonly code: "stale-plan" }
  | { readonly code: "malformed-plan" }
  | { readonly code: "malformed-kind" }
  | { readonly code: "malformed-overwrite" }
  | { readonly code: "malformed-destination" }
  | { readonly code: "malformed-plan-id" }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspaceMutationLimitName;
      readonly reason: "not-positive" | "not-safe-integer" | "above-hard-maximum";
    }
  | { readonly code: "plan-refused" }
  | { readonly code: "filesystem"; readonly reason: string };

export type WorkspaceMutationLimits = {
  readonly maxEntries: number;
  readonly maxDepth: number;
};

export const DEFAULT_MUTATION_LIMITS: WorkspaceMutationLimits = {
  maxEntries: DEFAULT_MAX_MUTATION_ENTRIES,
  maxDepth: DEFAULT_MAX_MUTATION_DEPTH,
};

export type ParsedWorkspaceMutation = {
  readonly operation: WorkspaceMutationOperation;
  readonly source: string;
  readonly destination: string | null;
  readonly overwrite: OverwritePolicy;
  readonly recursive: boolean;
  readonly expectedPlanId: string | null;
  readonly limits: WorkspaceMutationLimits;
};

export type MutationAffectedEntry = {
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly role: "source" | "destination";
};

export type WorkspaceMutationPreview = {
  readonly operation: WorkspaceMutationOperation;
  readonly planId: string;
  readonly source: BoundWorkspacePath;
  readonly destination: BoundWorkspacePath | null;
  readonly overwrite: OverwritePolicy;
  readonly recursive: boolean;
  readonly entries: readonly MutationAffectedEntry[];
};

export type WorkspaceMutationItemStatus = "applied" | "failed" | "unscheduled" | "cancelled";

export type WorkspaceMutationItem = {
  readonly index: number;
  readonly status: WorkspaceMutationItemStatus;
  readonly logical: string;
  readonly resolved: LocalPath | null;
  readonly error: WorkspaceMutationError | null;
};

export type WorkspaceMutationResult = {
  readonly operation: WorkspaceMutationOperation;
  readonly planId: string;
  readonly transport: MutationTransport | null;
  readonly items: readonly WorkspaceMutationItem[];
};

const HARD_LIMITS: Readonly<Record<WorkspaceMutationLimitName, number>> = {
  maxEntries: HARD_MAX_MUTATION_ENTRIES,
  maxDepth: HARD_MAX_MUTATION_DEPTH,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is WorkspaceMutationOperation {
  return value === "move" || value === "copy" || value === "remove" || value === "trash";
}

function isOverwrite(value: unknown): value is OverwritePolicy {
  return value === "error" || value === "replace" || value === "merge";
}

function parseLimit(
  value: unknown,
  field: WorkspaceMutationLimitName,
  fallback: number,
): Result<number, WorkspaceMutationError> {
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

function parsePathField(value: unknown): Result<string, WorkspaceMutationError> {
  if (typeof value !== "string") {
    return err({ code: "malformed", reason: "path-not-a-string" });
  }
  if (value.length === 0) {
    return err({ code: "malformed", reason: "path-empty" });
  }
  if (value.includes("\0")) {
    return err({ code: "malformed", reason: "path-illegal-character" });
  }
  return ok(value);
}

/** Stable identity for a previewed mutation. Not a security control. */
export function computeMutationPlanId(
  operation: WorkspaceMutationOperation,
  source: string,
  destination: string | null,
  overwrite: OverwritePolicy,
  recursive: boolean,
  logicals: readonly string[],
): string {
  const canonical = [
    operation,
    source,
    destination ?? "",
    overwrite,
    recursive ? "recursive" : "single",
    ...logicals,
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mutate-${hash.toString(16).padStart(8, "0")}-${canonical.length}`;
}

export function destinationInsideSource(source: LocalPath, destination: LocalPath): boolean {
  return destination !== source && isInside(source, destination);
}

export function parseWorkspaceMutation(
  value: unknown,
): Result<ParsedWorkspaceMutation, WorkspaceMutationError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  if (!isOperation(value.kind)) {
    return err({ code: "malformed-kind" });
  }
  const source = parsePathField(value.source);
  if (!source.ok) {
    return source;
  }
  let destination: string | null = null;
  if (value.kind === "remove") {
    if (value.destination !== undefined) {
      return err({ code: "malformed-destination" });
    }
  } else if (value.kind === "trash" && value.destination === undefined) {
    return err({ code: "unsupported-trash" });
  } else {
    const parsed = parsePathField(value.destination);
    if (!parsed.ok) {
      return err({ code: "malformed-destination" });
    }
    destination = parsed.value;
  }
  const overwrite = value.overwrite === undefined ? "error" : value.overwrite;
  if (!isOverwrite(overwrite)) {
    return err({ code: "malformed-overwrite" });
  }
  if (value.recursive !== undefined && typeof value.recursive !== "boolean") {
    return err({ code: "malformed-plan" });
  }
  let expectedPlanId: string | null = null;
  if (value.expectedPlanId !== undefined) {
    if (
      typeof value.expectedPlanId !== "string" ||
      !/^mutate-[0-9a-f]+-\d+$/.test(value.expectedPlanId)
    ) {
      return err({ code: "malformed-plan-id" });
    }
    expectedPlanId = value.expectedPlanId;
  }
  const maxEntries = parseLimit(value.maxEntries, "maxEntries", DEFAULT_MUTATION_LIMITS.maxEntries);
  if (!maxEntries.ok) {
    return maxEntries;
  }
  const maxDepth = parseLimit(value.maxDepth, "maxDepth", DEFAULT_MUTATION_LIMITS.maxDepth);
  if (!maxDepth.ok) {
    return maxDepth;
  }
  return ok({
    operation: value.kind,
    source: source.value,
    destination,
    overwrite,
    recursive: value.recursive === true,
    expectedPlanId,
    limits: { maxEntries: maxEntries.value, maxDepth: maxDepth.value },
  });
}

export function describeWorkspaceMutationError(error: WorkspaceMutationError): string {
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
    case "already-exists":
      return "already-exists";
    case "not-a-file":
      return "not-a-file";
    case "not-empty":
      return "not-empty";
    case "into-self":
      return "into-self";
    case "too-broad":
      return `too-broad:${error.truncation}`;
    case "unsupported-trash":
      return "unsupported-trash";
    case "stale-plan":
      return "stale-plan";
    case "malformed-plan":
      return "malformed-plan";
    case "malformed-kind":
      return "malformed-kind";
    case "malformed-overwrite":
      return "malformed-overwrite";
    case "malformed-destination":
      return "malformed-destination";
    case "malformed-plan-id":
      return "malformed-plan-id";
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "plan-refused":
      return "plan-refused";
    case "filesystem":
      return `filesystem:${error.reason}`;
    default:
      return assertNever(error, "unhandled workspace mutation error");
  }
}
