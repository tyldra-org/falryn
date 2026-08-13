/**
 * Workspace list, stat, and bounded walk contracts (#280).
 *
 * Listing is metadata only. File bytes are #56. Search and patches remain later
 * #54 children. Descent never follows a symlink.
 */

import type { FileKind, LocalPath, PathEntry } from "./filesystem.ts";
import { assertNever } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";

export const DEFAULT_MAX_LIST_ENTRIES = 10_000;
export const DEFAULT_MAX_WALK_ENTRIES = 10_000;
export const DEFAULT_MAX_WALK_DEPTH = 16;

export type WorkspaceListingError =
  | WorkspacePathBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "not-found" }
  | { readonly code: "not-a-directory" }
  | { readonly code: "cancelled" }
  | { readonly code: "filesystem"; readonly reason: string };

export type WorkspaceEntry = {
  readonly requested: string;
  readonly logical: string;
  readonly resolved: LocalPath;
  readonly kind: FileKind;
  readonly byteLength: number;
  readonly mode: number | null;
};

export type WorkspaceEntryFailure = {
  readonly logical: string;
  readonly error: WorkspaceListingError;
};

export type WorkspaceStatResult = WorkspaceEntry;

export type WorkspaceListResult = {
  readonly directory: BoundWorkspacePath;
  readonly entries: readonly WorkspaceEntry[];
  readonly failures: readonly WorkspaceEntryFailure[];
  readonly truncated: boolean;
};

export type WalkTruncation = "entry-limit" | "depth-limit";

export type WorkspaceWalkResult = {
  readonly start: BoundWorkspacePath;
  readonly entries: readonly WorkspaceEntry[];
  readonly failures: readonly WorkspaceEntryFailure[];
  readonly truncated: boolean;
  readonly truncation: WalkTruncation | null;
};

export type WorkspaceListingLimits = {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly includeHidden: boolean;
};

export const DEFAULT_LISTING_LIMITS: WorkspaceListingLimits = {
  maxEntries: DEFAULT_MAX_WALK_ENTRIES,
  maxDepth: DEFAULT_MAX_WALK_DEPTH,
  includeHidden: true,
};

export function listingLimits(
  overrides: Partial<WorkspaceListingLimits> = {},
): WorkspaceListingLimits {
  return {
    maxEntries: overrides.maxEntries ?? DEFAULT_LISTING_LIMITS.maxEntries,
    maxDepth: overrides.maxDepth ?? DEFAULT_LISTING_LIMITS.maxDepth,
    includeHidden: overrides.includeHidden ?? DEFAULT_LISTING_LIMITS.includeHidden,
  };
}

export function isHiddenLogical(logical: string): boolean {
  return logical.split("/").some((segment) => segment.startsWith("."));
}

export function compareWorkspaceEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return left.logical.localeCompare(right.logical);
}

export function entryFromStat(bound: BoundWorkspacePath, stat: PathEntry): WorkspaceEntry {
  return {
    requested: bound.requested,
    logical: bound.logical,
    resolved: bound.resolved,
    kind: stat.kind,
    byteLength: stat.byteLength,
    mode: stat.mode,
  };
}

export function describeWorkspaceListingError(error: WorkspaceListingError): string {
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
    default:
      return assertNever(error, "unhandled workspace listing error");
  }
}
