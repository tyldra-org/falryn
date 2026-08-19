/**
 * Reviewable commit-plan advice from actual changes (#126).
 *
 * Composes the #80 `planGitCommits` baseline. User-selected scope keeps
 * unrelated inventory out of groups. The result is advice: this module does
 * not stage, commit, or talk to Git.
 */

import { z } from "zod";

import { planGitCommits } from "./commit-plan.ts";
import {
  COMMIT_PLAN_VERSION,
  type CommitChangeUnit,
  type CommitPlan,
  type GitIdentity,
  type GitStatusEntry,
} from "./git.ts";
import { type OutcomeId, outcomeId, type TaskId, taskId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const TASK_COMMIT_PLAN_VERSION = "task-commit-plan.v1";
export const TASK_COMMIT_PLAN_SOURCE = "composed-git-status-log";
export const MAX_COMMIT_SCOPE_PATHS = 256;
export const MAX_COMMIT_SCOPE_PATH_BYTES = 512;

export type TaskCommitPlanErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "unavailable"
  | "unsupported";

export type TaskCommitPlanError = {
  readonly kind: "task-commit-plan";
  readonly code: TaskCommitPlanErrorCode;
  readonly field: string | null;
};

export type TaskCommitPlanProvenance = {
  readonly version: typeof TASK_COMMIT_PLAN_VERSION;
  readonly source: typeof TASK_COMMIT_PLAN_SOURCE;
  readonly model: null;
  readonly plannerVersion: typeof COMMIT_PLAN_VERSION;
};

export type TaskCommitAdvice = {
  readonly outcomeId: OutcomeId;
  readonly taskId: TaskId | null;
  readonly plan: CommitPlan;
  readonly omittedPaths: readonly string[];
  readonly provenance: TaskCommitPlanProvenance;
};

export type TaskCommitPlanInput = {
  readonly outcomeId: unknown;
  readonly taskId?: unknown;
  readonly scope?: unknown;
  readonly identity: GitIdentity;
  readonly plan: CommitPlan;
  readonly subjects?: unknown;
  readonly model?: unknown;
};

const encoder = new TextEncoder();

function commitPlanError(code: TaskCommitPlanErrorCode, field: string | null): TaskCommitPlanError {
  return { kind: "task-commit-plan", code, field };
}

export function describeTaskCommitPlanError(error: TaskCommitPlanError): string {
  const field = error.field === null ? "advice" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "empty":
      return `empty ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return `secret ${field}`;
    case "unavailable":
      return `unavailable ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-commit-plan error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBoundedPath(value: unknown, field: string): Result<string, TaskCommitPlanError> {
  if (typeof value !== "string") {
    return err(commitPlanError("malformed", field));
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    return err(commitPlanError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(commitPlanError("empty", field));
  }
  if (trimmed.includes("..")) {
    return err(commitPlanError("malformed", field));
  }
  if (byteLength(trimmed) > MAX_COMMIT_SCOPE_PATH_BYTES) {
    return err(commitPlanError("oversized", field));
  }
  return ok(trimmed);
}

const subjectsSchema = z.array(z.string());

function unitToEntry(unit: CommitChangeUnit): GitStatusEntry {
  if (unit.kind === "untracked") {
    return {
      kind: "untracked",
      path: unit.path,
      originalPath: unit.originalPath,
      indexStatus: "?",
      worktreeStatus: "?",
    };
  }
  if (unit.kind === "unmerged") {
    return {
      kind: "unmerged",
      path: unit.path,
      originalPath: unit.originalPath,
      indexStatus: "U",
      worktreeStatus: "U",
    };
  }
  const staged = unit.states.includes("staged");
  const unstaged = unit.states.includes("unstaged");
  return {
    kind: unit.kind,
    path: unit.path,
    originalPath: unit.originalPath,
    indexStatus: staged ? "M" : ".",
    worktreeStatus: unstaged ? "M" : ".",
  };
}

function advice(
  outcomeIdValue: OutcomeId,
  taskIdValue: TaskId | null,
  plan: CommitPlan,
  omittedPaths: readonly string[],
): TaskCommitAdvice {
  return {
    outcomeId: outcomeIdValue,
    taskId: taskIdValue,
    plan,
    omittedPaths,
    provenance: {
      version: TASK_COMMIT_PLAN_VERSION,
      source: TASK_COMMIT_PLAN_SOURCE,
      model: null,
      plannerVersion: COMMIT_PLAN_VERSION,
    },
  };
}

/**
 * Attaches outcome lineage and optional user-selected scope to an #80 commit
 * plan. Paths outside the selected scope are omitted rather than grouped.
 */
export function planTaskCommits(
  input: TaskCommitPlanInput,
  signal?: AbortSignal,
): Result<TaskCommitAdvice, TaskCommitPlanError> {
  if (signal?.aborted) {
    return err(commitPlanError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(commitPlanError("unsupported", "model"));
  }
  const id = outcomeId.parse(input.outcomeId);
  if (!id.ok) {
    return err(commitPlanError("malformed", "outcomeId"));
  }
  let linkedTask: TaskId | null = null;
  if (input.taskId !== undefined) {
    const parsedTask = taskId.parse(input.taskId);
    if (!parsedTask.ok) {
      return err(commitPlanError("malformed", "taskId"));
    }
    linkedTask = parsedTask.value;
  }
  let subjects: readonly string[] = [];
  if (input.subjects !== undefined) {
    const parsedSubjects = subjectsSchema.safeParse(input.subjects);
    if (!parsedSubjects.success) {
      return err(commitPlanError("malformed", "subjects"));
    }
    subjects = parsedSubjects.data;
  }
  if (input.scope === undefined) {
    if (input.plan.inventory.length === 0) {
      return err(commitPlanError("empty", "plan.inventory"));
    }
    return ok(advice(id.value, linkedTask, input.plan, []));
  }
  if (!Array.isArray(input.scope)) {
    return err(commitPlanError("malformed", "scope"));
  }
  if (input.scope.length > MAX_COMMIT_SCOPE_PATHS) {
    return err(commitPlanError("oversized", "scope"));
  }
  if (input.scope.length === 0) {
    return err(commitPlanError("empty", "scope"));
  }
  const selected = new Set<string>();
  const inventoryPaths = new Set(input.plan.inventory.map((unit) => unit.path));
  for (const [index, raw] of input.scope.entries()) {
    const path = parseBoundedPath(raw, `scope.${index}`);
    if (!path.ok) {
      return path;
    }
    if (selected.has(path.value)) {
      return err(commitPlanError("malformed", `scope.${index}`));
    }
    if (!inventoryPaths.has(path.value)) {
      return err(commitPlanError("malformed", `scope.${index}`));
    }
    selected.add(path.value);
  }
  const omittedPaths = input.plan.inventory
    .map((unit) => unit.path)
    .filter((path) => !selected.has(path));
  const scoped = input.plan.inventory.filter((unit) => selected.has(unit.path));
  if (scoped.length === 0) {
    return err(commitPlanError("empty", "scope"));
  }
  const planned = planGitCommits({
    identity: input.identity,
    entries: scoped.map(unitToEntry),
    truncated: input.plan.validation.truncated,
    subjects,
  });
  return ok(advice(id.value, linkedTask, planned, omittedPaths));
}
