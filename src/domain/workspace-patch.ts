/**
 * Workspace patch hunk preview, conflict, and apply contracts (#66).
 *
 * Hunks match exact preimage text at an explicit line. They are never moved to
 * similar text. Best-effort rollback and changed-region reads are this slice.
 * Optional Git observation refuses in-progress operations and unmerged paths.
 * Product tools remain later work.
 */

import { type ContentDigest, contentDigest } from "./artifact.ts";
import type { GitField, GitOperationState, GitStatusEntry, GitStatusSnapshot } from "./git.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";
import { applyLineRange, type LineRange, type NumberedLine } from "./workspace-read.ts";
import {
  DEFAULT_MAX_WRITE_AGGREGATE_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  DEFAULT_MAX_WRITE_TARGETS,
  HARD_MAX_WRITE_AGGREGATE_BYTES,
  HARD_MAX_WRITE_BYTES,
  HARD_MAX_WRITE_TARGETS,
  MAX_WRITE_REVISION_LENGTH,
  type WorkspaceWriteOverlapReason,
  type WorkspaceWritePolicy,
  WRITE_POLICIES,
} from "./workspace-write.ts";

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
  readonly oldStart: number;
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

const HARD_LIMITS: Readonly<Record<WorkspacePatchLimitName, number>> = {
  maxTargets: HARD_MAX_PATCH_TARGETS,
  maxHunks: HARD_MAX_PATCH_HUNKS,
  maxHunkLines: HARD_MAX_PATCH_HUNK_LINES,
  maxFileBytes: HARD_MAX_WRITE_BYTES,
  maxAggregateBytes: HARD_MAX_WRITE_AGGREGATE_BYTES,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicy(value: unknown): value is PatchPolicy {
  return (WRITE_POLICIES as readonly string[]).includes(value as string);
}

function parseLimit(
  value: unknown,
  field: WorkspacePatchLimitName,
  fallback: number,
): Result<number, WorkspacePatchError> {
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

function parsePath(value: unknown): Result<string, WorkspacePatchError> {
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

function parseLineList(value: unknown): Result<readonly string[], WorkspacePatchError> {
  if (!Array.isArray(value)) {
    return err({ code: "malformed-hunk" });
  }
  const lines: string[] = [];
  for (const line of value) {
    if (
      typeof line !== "string" ||
      line.includes("\0") ||
      line.includes("\n") ||
      line.includes("\r")
    ) {
      return err({ code: "malformed-text" });
    }
    lines.push(line);
  }
  return ok(lines);
}

function hunksOverlap(left: ParsedPatchHunk, right: ParsedPatchHunk): boolean {
  const leftInsert = left.oldLines.length === 0;
  const rightInsert = right.oldLines.length === 0;
  const leftEnd = leftInsert ? left.oldStart : left.oldStart + left.oldLines.length;
  const rightEnd = rightInsert ? right.oldStart : right.oldStart + right.oldLines.length;
  if (leftInsert && rightInsert) {
    return left.oldStart === right.oldStart;
  }
  if (leftInsert) {
    return left.oldStart >= right.oldStart && left.oldStart < rightEnd;
  }
  if (rightInsert) {
    return right.oldStart >= left.oldStart && right.oldStart < leftEnd;
  }
  return left.oldStart < rightEnd && right.oldStart < leftEnd;
}

function parseHunk(
  value: unknown,
  index: number,
  maxHunkLines: number,
): Result<ParsedPatchHunk, WorkspacePatchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-hunk" });
  }
  if (
    typeof value.oldStart !== "number" ||
    !Number.isSafeInteger(value.oldStart) ||
    value.oldStart < 1
  ) {
    return err({ code: "malformed-hunk" });
  }
  const oldLines = parseLineList(value.oldLines);
  if (!oldLines.ok) {
    return oldLines;
  }
  const newLines = parseLineList(value.newLines);
  if (!newLines.ok) {
    return newLines;
  }
  if (oldLines.value.length === 0 && newLines.value.length === 0) {
    return err({ code: "malformed-hunk" });
  }
  if (oldLines.value.length > maxHunkLines || newLines.value.length > maxHunkLines) {
    return err({ code: "malformed-limit", field: "maxHunkLines", reason: "above-hard-maximum" });
  }
  return ok({
    index,
    oldStart: value.oldStart,
    oldLines: oldLines.value,
    newLines: newLines.value,
  });
}

function parseTarget(
  value: unknown,
  index: number,
  limits: WorkspacePatchLimits,
): Result<ParsedPatchTarget, WorkspacePatchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  const path = parsePath(value.path);
  if (!path.ok) {
    return path;
  }
  if (!Array.isArray(value.hunks) || value.hunks.length === 0) {
    return err({ code: "malformed-hunk" });
  }
  if (value.hunks.length > limits.maxHunks) {
    return err({ code: "malformed-limit", field: "maxHunks", reason: "above-hard-maximum" });
  }
  const hunks: ParsedPatchHunk[] = [];
  for (const [hunkIndex, hunk] of value.hunks.entries()) {
    const parsed = parseHunk(hunk, hunkIndex, limits.maxHunkLines);
    if (!parsed.ok) {
      return parsed;
    }
    hunks.push(parsed.value);
  }
  const ordered = [...hunks].sort((left, right) => left.oldStart - right.oldStart);
  for (let indexHunk = 1; indexHunk < ordered.length; indexHunk += 1) {
    const previous = ordered[indexHunk - 1];
    const current = ordered[indexHunk];
    if (previous === undefined || current === undefined || hunksOverlap(previous, current)) {
      return err({ code: "overlapping-hunks" });
    }
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
  return ok({
    index,
    path: path.value,
    expectedDigest,
    expectedRevision,
    hunks: ordered,
  });
}

function logicalKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function stripPrivatePrefix(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

export function gitPathForPatchTarget(
  worktreeRoot: string,
  workspaceRoot: string,
  patchPath: string,
): string {
  const worktree = stripPrivatePrefix(worktreeRoot.replace(/\/+$/, ""));
  const workspace = stripPrivatePrefix(workspaceRoot.replace(/\/+$/, ""));
  const logical = logicalKey(patchPath);
  if (workspace === worktree) {
    return logical;
  }
  if (workspace.startsWith(`${worktree}/`)) {
    return logicalKey(`${workspace.slice(worktree.length + 1)}/${logical}`);
  }
  return logical;
}

function isDirtyGitKind(kind: GitStatusEntry["kind"]): boolean {
  switch (kind) {
    case "ordinary":
    case "rename":
    case "untracked":
      return true;
    case "unmerged":
    case "ignored":
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function assessPatchGitStatus(
  snapshot: GitStatusSnapshot,
  workspaceRoot: string,
  targetPaths: readonly string[],
  expectedGitHead: string | null,
): Result<Extract<PatchGitObservation, { readonly state: "observed" }>, WorkspacePatchError> {
  if (expectedGitHead !== null) {
    if (
      snapshot.identity.head.state !== "observed" ||
      snapshot.identity.head.value !== expectedGitHead
    ) {
      return err({ code: "git-head-mismatch" });
    }
  }
  if (snapshot.identity.operation !== "clean") {
    return err({ code: "git-operation", operation: snapshot.identity.operation });
  }
  switch (snapshot.entries.state) {
    case "unavailable":
      return err({ code: "git-unavailable", reason: snapshot.entries.reason });
    case "observed":
    case "truncated": {
      const mapped = new Map(
        snapshot.entries.value.map((entry) => [logicalKey(entry.path), entry]),
      );
      const dirtyTargets: string[] = [];
      for (const path of targetPaths) {
        const gitPath = gitPathForPatchTarget(snapshot.identity.worktreeRoot, workspaceRoot, path);
        const entry = mapped.get(logicalKey(gitPath));
        if (entry === undefined) {
          if (snapshot.entries.state === "truncated") {
            return err({ code: "git-unavailable", reason: "truncated" });
          }
          continue;
        }
        if (entry.kind === "unmerged") {
          return err({ code: "git-conflict" });
        }
        if (isDirtyGitKind(entry.kind)) {
          dirtyTargets.push(path);
        }
      }
      return ok({
        state: "observed",
        operation: snapshot.identity.operation,
        head: snapshot.identity.head,
        dirtyTargets,
      });
    }
    default: {
      const _exhaustive: never = snapshot.entries;
      return _exhaustive;
    }
  }
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

/** Stable identity for a previewed patch. Not a security control. */
export function computePatchPlanId(plan: ParsedPatchPlan): string {
  const canonical = [
    plan.policy,
    plan.expectedGitHead ?? "",
    ...plan.targets.flatMap((target) => [
      target.path,
      target.expectedDigest ?? "",
      target.expectedRevision ?? "",
      ...target.hunks.flatMap((hunk) => [
        String(hunk.oldStart),
        ...hunk.oldLines,
        "+",
        ...hunk.newLines,
      ]),
    ]),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `patch-${hash.toString(16).padStart(8, "0")}-${canonical.length}`;
}

export function hunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

export type PatchHunkApplyResult = {
  readonly lines: readonly string[];
  readonly regions: readonly LineRange[];
  readonly hunks: readonly PatchHunkPreview[];
};

function linesEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((line, index) => line === right[index]);
}

function conflictContext(
  lines: readonly string[],
  start: number,
  count: number,
): {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly foundCount: number;
  readonly found: readonly string[];
} {
  const startIndex = Math.max(0, start - 1);
  const available = Math.max(0, lines.length - startIndex);
  const found = lines.slice(
    startIndex,
    startIndex + Math.min(Math.max(count, 1), available, MAX_CONFLICT_CONTEXT_LINES),
  );
  return {
    lineStart: start,
    lineEnd: start + found.length,
    foundCount: found.length,
    found,
  };
}

/** Applies exact hunks to numbered lines. Never relocates a mismatched hunk. */
export function applyPatchHunks(
  lines: readonly string[],
  hunks: readonly ParsedPatchHunk[],
): Result<PatchHunkApplyResult, WorkspacePatchError> {
  const previews: PatchHunkPreview[] = [];
  const regions: LineRange[] = [];
  let delta = 0;
  for (const hunk of hunks) {
    const oldCount = hunk.oldLines.length;
    const newCount = hunk.newLines.length;
    const newStart = hunk.oldStart + delta;
    const startIndex = hunk.oldStart - 1;
    if (oldCount === 0) {
      if (startIndex < 0 || startIndex > lines.length) {
        return err({
          code: "conflict",
          hunkIndex: hunk.index,
          ...conflictContext(lines, hunk.oldStart, 1),
        });
      }
    } else if (startIndex < 0 || startIndex + oldCount > lines.length) {
      return err({
        code: "conflict",
        hunkIndex: hunk.index,
        ...conflictContext(lines, hunk.oldStart, oldCount),
      });
    } else if (!linesEqual(lines.slice(startIndex, startIndex + oldCount), hunk.oldLines)) {
      return err({
        code: "conflict",
        hunkIndex: hunk.index,
        ...conflictContext(lines, hunk.oldStart, oldCount),
      });
    }
    previews.push({
      index: hunk.index,
      status: "ready",
      header: hunkHeader(hunk.oldStart, oldCount, newStart, newCount),
      oldStart: hunk.oldStart,
      oldCount,
      newStart,
      newCount,
    });
    regions.push({ start: newStart, end: newStart + newCount });
    delta += newCount - oldCount;
  }
  const next = [...lines];
  for (const hunk of [...hunks].reverse()) {
    next.splice(hunk.oldStart - 1, hunk.oldLines.length, ...hunk.newLines);
  }
  return ok({ lines: next, regions, hunks: previews });
}

export function joinPatchedLines(
  lines: readonly string[],
  newline: "lf" | "crlf" | "cr",
  trailingNewline: boolean,
): string {
  const mark = newline === "crlf" ? "\r\n" : newline === "cr" ? "\r" : "\n";
  if (lines.length === 1 && lines[0] === "" && !trailingNewline) {
    return "";
  }
  const body = lines.join(mark);
  return trailingNewline ? `${body}${mark}` : body;
}

export function parseWorkspacePatchPlan(
  value: unknown,
): Result<ParsedPatchPlan, WorkspacePatchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  const policy = value.policy === undefined ? "fail-before-effect" : value.policy;
  if (!isPolicy(policy)) {
    return err({ code: "malformed-policy" });
  }
  let expectedPlanId: string | null = null;
  if (value.expectedPlanId !== undefined) {
    if (
      typeof value.expectedPlanId !== "string" ||
      !/^patch-[0-9a-f]+-\d+$/.test(value.expectedPlanId)
    ) {
      return err({ code: "malformed-plan-id" });
    }
    expectedPlanId = value.expectedPlanId;
  }
  const maxTargets = parseLimit(value.maxTargets, "maxTargets", DEFAULT_PATCH_LIMITS.maxTargets);
  if (!maxTargets.ok) {
    return maxTargets;
  }
  const maxHunks = parseLimit(value.maxHunks, "maxHunks", DEFAULT_PATCH_LIMITS.maxHunks);
  if (!maxHunks.ok) {
    return maxHunks;
  }
  const maxHunkLines = parseLimit(
    value.maxHunkLines,
    "maxHunkLines",
    DEFAULT_PATCH_LIMITS.maxHunkLines,
  );
  if (!maxHunkLines.ok) {
    return maxHunkLines;
  }
  const maxFileBytes = parseLimit(
    value.maxFileBytes,
    "maxFileBytes",
    DEFAULT_PATCH_LIMITS.maxFileBytes,
  );
  if (!maxFileBytes.ok) {
    return maxFileBytes;
  }
  const maxAggregateBytes = parseLimit(
    value.maxAggregateBytes,
    "maxAggregateBytes",
    DEFAULT_PATCH_LIMITS.maxAggregateBytes,
  );
  if (!maxAggregateBytes.ok) {
    return maxAggregateBytes;
  }
  const limits: WorkspacePatchLimits = {
    maxTargets: maxTargets.value,
    maxHunks: maxHunks.value,
    maxHunkLines: maxHunkLines.value,
    maxFileBytes: maxFileBytes.value,
    maxAggregateBytes: maxAggregateBytes.value,
  };
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    return err({ code: "malformed-plan" });
  }
  if (value.targets.length > limits.maxTargets) {
    return err({ code: "malformed-limit", field: "maxTargets", reason: "above-hard-maximum" });
  }
  const targets: ParsedPatchTarget[] = [];
  for (const [index, target] of value.targets.entries()) {
    const parsed = parseTarget(target, index, limits);
    if (!parsed.ok) {
      return parsed;
    }
    targets.push(parsed.value);
  }
  const overlap = detectOverlap(targets.map((target) => target.path));
  if (overlap !== null) {
    return err({ code: "overlapping-targets", reason: overlap });
  }
  let expectedGitHead: string | null = null;
  if (value.expectedGitHead !== undefined) {
    if (
      typeof value.expectedGitHead !== "string" ||
      value.expectedGitHead.length === 0 ||
      value.expectedGitHead.length > MAX_WRITE_REVISION_LENGTH ||
      value.expectedGitHead.includes("\0")
    ) {
      return err({ code: "malformed-revision" });
    }
    expectedGitHead = value.expectedGitHead;
  }
  return ok({ policy, expectedPlanId, expectedGitHead, limits, targets });
}

export function summarizePatchRollback(
  attempted: boolean,
  restored: readonly number[],
  failed: readonly WorkspacePatchRollback["failed"][number][],
): WorkspacePatchRollback {
  if (!attempted) {
    return NOT_ATTEMPTED_PATCH_ROLLBACK;
  }
  if (failed.length === 0) {
    return { status: "complete", restored, failed: [] };
  }
  if (restored.length === 0) {
    return { status: "failed", restored: [], failed };
  }
  return { status: "partial", restored, failed };
}

export function linesForChangedRegion(
  text: string,
  range: LineRange,
): Result<
  { readonly lines: readonly NumberedLine[]; readonly truncated: boolean },
  WorkspacePatchError
> {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end < range.start
  ) {
    return err({ code: "malformed-range" });
  }
  if (range.end === range.start) {
    return ok({ lines: [], truncated: false });
  }
  const sliced = applyLineRange(text, { start: range.start, end: range.end - 1 });
  if ("error" in sliced) {
    return err({ code: "malformed-range" });
  }
  if (sliced.lines.length <= MAX_CHANGED_REGION_LINES) {
    return ok({ lines: sliced.lines, truncated: false });
  }
  return ok({
    lines: sliced.lines.slice(0, MAX_CHANGED_REGION_LINES),
    truncated: true,
  });
}

function parseLineRange(value: unknown): Result<LineRange, WorkspacePatchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-range" });
  }
  if (
    typeof value.start !== "number" ||
    typeof value.end !== "number" ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    value.start < 1 ||
    value.end < value.start
  ) {
    return err({ code: "malformed-range" });
  }
  return ok({ start: value.start, end: value.end });
}

export function parsePatchChangedRegionRead(
  value: unknown,
): Result<ParsedPatchChangedRegionRead, WorkspacePatchError> {
  if (!isRecord(value)) {
    return err({ code: "malformed-plan" });
  }
  const path = parsePath(value.path);
  if (!path.ok) {
    return path;
  }
  const maxFileBytes = parseLimit(
    value.maxFileBytes,
    "maxFileBytes",
    DEFAULT_PATCH_LIMITS.maxFileBytes,
  );
  if (!maxFileBytes.ok) {
    return maxFileBytes;
  }
  if (!Array.isArray(value.regions) || value.regions.length === 0) {
    return err({ code: "malformed-range" });
  }
  if (value.regions.length > HARD_MAX_PATCH_HUNKS) {
    return err({ code: "malformed-limit", field: "maxHunks", reason: "above-hard-maximum" });
  }
  const regions: LineRange[] = [];
  for (const region of value.regions) {
    const parsed = parseLineRange(region);
    if (!parsed.ok) {
      return parsed;
    }
    regions.push(parsed.value);
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
  return ok({
    path: path.value,
    expectedDigest,
    expectedRevision,
    maxFileBytes: maxFileBytes.value,
    regions,
  });
}

export function describeWorkspacePatchError(error: WorkspacePatchError): string {
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
    case "not-a-file":
      return "not-a-file";
    case "digest-mismatch":
      return "digest-mismatch";
    case "revision-mismatch":
      return "revision-mismatch";
    case "cancelled":
      return "cancelled";
    case "unsupported":
      return "unsupported";
    case "stale-plan":
      return "stale-plan";
    case "malformed-plan":
      return "malformed-plan";
    case "malformed-plan-id":
      return "malformed-plan-id";
    case "malformed-policy":
      return "malformed-policy";
    case "malformed-digest":
      return "malformed-digest";
    case "malformed-revision":
      return "malformed-revision";
    case "malformed-hunk":
      return "malformed-hunk";
    case "malformed-text":
      return "malformed-text";
    case "overlapping-targets":
      return `overlapping-targets:${error.reason}`;
    case "overlapping-hunks":
      return "overlapping-hunks";
    case "conflict":
      return `conflict:${error.hunkIndex}`;
    case "malformed-limit":
      return `malformed-limit:${error.field}:${error.reason}`;
    case "oversized":
      return "oversized";
    case "aggregate-limit":
      return "aggregate-limit";
    case "plan-refused":
      return "plan-refused";
    case "malformed-range":
      return "malformed-range";
    case "rollback-failed":
      return `rollback-failed:${error.reason}`;
    case "filesystem":
      return `filesystem:${error.reason}`;
    case "git-conflict":
      return "git-conflict";
    case "git-head-mismatch":
      return "git-head-mismatch";
    case "git-operation":
      return `git-operation:${error.operation}`;
    case "git-unavailable":
      return `git-unavailable:${error.reason}`;
    default:
      return assertNever(error, "unhandled workspace patch error");
  }
}
