/** Stable workspace patch plans, previews, results, and rollback contracts. */

import type { ContentDigest } from "../artifact.ts";
import type { GitField, GitOperationState } from "../git.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "../workspace-path.ts";
import type { LineRange, NumberedLine } from "../workspace-read.ts";
import {
  DEFAULT_MAX_WRITE_AGGREGATE_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  DEFAULT_MAX_WRITE_TARGETS,
  HARD_MAX_WRITE_TARGETS,
  type WorkspaceWriteOverlapReason,
  type WorkspaceWritePolicy,
} from "../workspace-write.ts";

export const DEFAULT_MAX_PATCH_TARGETS = DEFAULT_MAX_WRITE_TARGETS;
export const DEFAULT_MAX_PATCH_HUNKS = 32;
export const DEFAULT_MAX_PATCH_HUNK_LINES = 256;
export const HARD_MAX_PATCH_TARGETS = HARD_MAX_WRITE_TARGETS;
export const HARD_MAX_PATCH_HUNKS = 128;
export const HARD_MAX_PATCH_HUNK_LINES = 2_048;
export const MAX_CONFLICT_CONTEXT_LINES = 16;
export const MAX_CHANGED_REGION_LINES = 256;

export type PatchPolicy = WorkspaceWritePolicy;

export type WorkspacePatchLimitName =
  | "maxTargets"
  | "maxHunks"
  | "maxHunkLines"
  | "maxFileBytes"
  | "maxAggregateBytes";

export type WorkspacePatchError =
  | WorkspacePathBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "not-found" }
  | { readonly code: "not-a-file" }
  | { readonly code: "digest-mismatch" }
  | { readonly code: "revision-mismatch" }
  | { readonly code: "cancelled" }
  | { readonly code: "unsupported" }
  | { readonly code: "stale-plan" }
  | { readonly code: "malformed-plan" }
  | { readonly code: "malformed-plan-id" }
  | { readonly code: "malformed-policy" }
  | { readonly code: "malformed-digest" }
  | { readonly code: "malformed-revision" }
  | { readonly code: "malformed-hunk" }
  | { readonly code: "malformed-text" }
  | { readonly code: "overlapping-targets"; readonly reason: WorkspaceWriteOverlapReason }
  | { readonly code: "overlapping-hunks" }
  | {
      readonly code: "conflict";
      readonly hunkIndex: number;
      readonly lineStart: number;
      readonly lineEnd: number;
      readonly foundCount: number;
      readonly found: readonly string[];
    }
  | {
      readonly code: "malformed-limit";
      readonly field: WorkspacePatchLimitName;
      readonly reason: "not-positive" | "not-safe-integer" | "above-hard-maximum";
    }
  | { readonly code: "oversized"; readonly byteLength: number }
  | { readonly code: "aggregate-limit" }
  | { readonly code: "plan-refused" }
  | { readonly code: "malformed-range" }
  | {
      readonly code: "rollback-failed";
      readonly reason: WorkspacePatchRollbackReason;
    }
  | { readonly code: "filesystem"; readonly reason: string }
  | { readonly code: "git-conflict" }
  | { readonly code: "git-head-mismatch" }
  | {
      readonly code: "git-operation";
      readonly operation: Exclude<GitOperationState, "clean">;
    }
  | { readonly code: "git-unavailable"; readonly reason: string };

export const PATCH_GIT_UNAVAILABLE_REASONS = [
  "unsafe-ownership",
  "lock-contention",
  "timed-out",
  "output-exceeded",
  "spawn-failed",
  "failed",
  "invalid-request",
  "truncated",
] as const;
export type PatchGitUnavailableReason = (typeof PATCH_GIT_UNAVAILABLE_REASONS)[number];

export type PatchGitObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "observed";
      readonly operation: GitOperationState;
      readonly head: GitField<string>;
      readonly dirtyTargets: readonly string[];
    };

export type WorkspacePatchLimits = {
  readonly maxTargets: number;
  readonly maxHunks: number;
  readonly maxHunkLines: number;
  readonly maxFileBytes: number;
  readonly maxAggregateBytes: number;
};

export const DEFAULT_PATCH_LIMITS: WorkspacePatchLimits = {
  maxTargets: DEFAULT_MAX_PATCH_TARGETS,
  maxHunks: DEFAULT_MAX_PATCH_HUNKS,
  maxHunkLines: DEFAULT_MAX_PATCH_HUNK_LINES,
  maxFileBytes: DEFAULT_MAX_WRITE_BYTES,
  maxAggregateBytes: DEFAULT_MAX_WRITE_AGGREGATE_BYTES,
};

export type ParsedPatchHunk = {
  readonly index: number;
  /** Stable plan hunk identity when the caller named one (#614). */
  readonly hunkId: string | null;
  /**
   * 1-based old start when known. Null when the caller addressed by digest and
   * resolution against file lines is still required (#614).
   */
  readonly oldStart: number | null;
  /**
   * Optional `sha-256:` digest of the exact `oldLines` preimage. When set with
   * `oldStart`, the lines at that start must hash to this value. When set
   * without `oldStart`, the unique occurrence of `oldLines` supplies the start.
   */
  readonly addressDigest: ContentDigest | null;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
};

export type ParsedPatchTarget = {
  readonly index: number;
  readonly path: string;
  readonly expectedDigest: ContentDigest | null;
  readonly expectedRevision: string | null;
  readonly hunks: readonly ParsedPatchHunk[];
};

export type ParsedPatchPlan = {
  readonly policy: PatchPolicy;
  readonly expectedPlanId: string | null;
  readonly expectedGitHead: string | null;
  readonly limits: WorkspacePatchLimits;
  readonly targets: readonly ParsedPatchTarget[];
};

export type PatchHunkPreview = {
  readonly index: number;
  readonly status: "ready" | "conflict";
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
};

export type WorkspacePatchPreview = {
  readonly planId: string;
  readonly policy: PatchPolicy;
  readonly git: PatchGitObservation;
  readonly targets: readonly {
    readonly index: number;
    readonly path: string;
    readonly hunks: readonly PatchHunkPreview[];
  }[];
};

export type WorkspacePatchItemStatus =
  | "applied"
  | "rolled-back"
  | "failed"
  | "unscheduled"
  | "cancelled";

export type WorkspacePatchApplied = {
  readonly index: number;
  readonly status: "applied";
  readonly bound: BoundWorkspacePath;
  readonly digest: ContentDigest;
  readonly revision: string;
  readonly byteLength: number;
  readonly changedRegions: readonly LineRange[];
};

export type WorkspacePatchRolledBack = {
  readonly index: number;
  readonly status: "rolled-back";
  readonly bound: BoundWorkspacePath;
  readonly digest: ContentDigest;
  readonly revision: string;
  readonly byteLength: number;
};

export type WorkspacePatchRejected = {
  readonly index: number;
  readonly status: Exclude<WorkspacePatchItemStatus, "applied" | "rolled-back">;
  readonly requested: string;
  readonly resolved: BoundWorkspacePath["resolved"] | null;
  readonly error: WorkspacePatchError;
};

export type WorkspacePatchItem =
  | WorkspacePatchApplied
  | WorkspacePatchRolledBack
  | WorkspacePatchRejected;

export type WorkspacePatchRollbackReason = "concurrent-change" | "io-failure" | "cancelled";

export type WorkspacePatchRollback = {
  readonly status: "not-attempted" | "complete" | "partial" | "failed";
  readonly restored: readonly number[];
  readonly failed: readonly {
    readonly index: number;
    readonly error: Extract<WorkspacePatchError, { readonly code: "rollback-failed" }>;
  }[];
};

export const NOT_ATTEMPTED_PATCH_ROLLBACK: WorkspacePatchRollback = {
  status: "not-attempted",
  restored: [],
  failed: [],
};

export type WorkspacePatchResult = {
  readonly planId: string;
  readonly policy: PatchPolicy;
  readonly git: PatchGitObservation;
  readonly items: readonly WorkspacePatchItem[];
  readonly rollback: WorkspacePatchRollback;
};

export type ParsedPatchChangedRegionRead = {
  readonly path: string;
  readonly expectedDigest: ContentDigest | null;
  readonly expectedRevision: string | null;
  readonly maxFileBytes: number;
  readonly regions: readonly LineRange[];
};

export type WorkspacePatchChangedRegion = {
  readonly range: LineRange;
  readonly lines: readonly NumberedLine[];
  readonly truncated: boolean;
};

export type WorkspacePatchChangedRegionRead = {
  readonly path: string;
  readonly bound: BoundWorkspacePath;
  readonly digest: ContentDigest;
  readonly revision: string;
  readonly regions: readonly WorkspacePatchChangedRegion[];
};
