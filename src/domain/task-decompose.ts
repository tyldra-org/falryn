/**
 * Decompose a declared user outcome into bounded tasks (#123).
 *
 * The declared `goals` are the only work this slice will name. A proposed
 * task whose objective is not one of those goals is hidden scope growth and
 * is refused. The result is advice: it cannot execute Git, mutate a file,
 * confirm an effect, or mark work complete.
 *
 * Dependencies, joins, validation recommendations, commit plans, progress
 * projection, and model-assisted drafting remain later children of #122.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import { type OutcomeId, outcomeId, type TaskId, taskId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const TASK_DECOMPOSE_VERSION = "task-decompose.v1";
export const TASK_DECOMPOSE_SOURCE = "deterministic-goals";
export const MAX_OUTCOME_STATEMENT_BYTES = 4 * 1_024;
export const MAX_GOAL_BYTES = 512;
export const MAX_GOALS = 16;
export const MAX_NON_GOALS = 16;
export const MAX_BOUNDED_TASKS = MAX_GOALS;

export type TaskDecomposeErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "scope-growth"
  | "unsupported";

export type TaskDecomposeError = {
  readonly kind: "task-decompose";
  readonly code: TaskDecomposeErrorCode;
  readonly field: string | null;
};

export type TaskDecomposeProvenance = {
  readonly version: typeof TASK_DECOMPOSE_VERSION;
  readonly source: typeof TASK_DECOMPOSE_SOURCE;
  readonly model: null;
};

export type BoundedTask = {
  readonly taskId: TaskId;
  readonly outcomeId: OutcomeId;
  readonly objective: string;
  readonly goal: string;
  readonly nonGoals: readonly string[];
};

export type TaskDecomposition = {
  readonly outcomeId: OutcomeId;
  readonly statement: string;
  readonly goals: readonly string[];
  readonly nonGoals: readonly string[];
  readonly tasks: readonly BoundedTask[];
  readonly omittedGoals: readonly string[];
  readonly provenance: TaskDecomposeProvenance;
};

export type TaskDecomposeInput = {
  readonly outcomeId: unknown;
  readonly statement: unknown;
  readonly goals: unknown;
  readonly nonGoals?: unknown;
  readonly proposed?: unknown;
  readonly model?: unknown;
};

const encoder = new TextEncoder();

function taskError(code: TaskDecomposeErrorCode, field: string | null): TaskDecomposeError {
  return { kind: "task-decompose", code, field };
}

export function describeTaskDecomposeError(error: TaskDecomposeError): string {
  const field = error.field === null ? "outcome" : error.field;
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
    case "scope-growth":
      return `scope-growth ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-decompose error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, TaskDecomposeError> {
  if (typeof value !== "string") {
    return err(taskError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(taskError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(taskError("empty", field));
  }
  if (byteLength(trimmed) > maxBytes) {
    return err(taskError("oversized", field));
  }
  return ok(trimmed);
}

function parseTextList(
  value: unknown,
  field: string,
  maxItems: number,
  required: boolean,
): Result<readonly string[], TaskDecomposeError> {
  if (value === undefined) {
    return required ? err(taskError("empty", field)) : ok([]);
  }
  if (!Array.isArray(value)) {
    return err(taskError("malformed", field));
  }
  if (value.length > maxItems) {
    return err(taskError("oversized", field));
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const parsed = parseBoundedText(entry, `${field}.${index}`, MAX_GOAL_BYTES);
    if (!parsed.ok) {
      return parsed;
    }
    if (seen.has(parsed.value)) {
      return err(taskError("malformed", `${field}.${index}`));
    }
    seen.add(parsed.value);
    items.push(parsed.value);
  }
  if (required && items.length === 0) {
    return err(taskError("empty", field));
  }
  return ok(items);
}

const proposedSchema = z
  .object({
    taskId: brandedString(taskId),
    objective: z.string(),
  })
  .strict();

function parseProposed(
  value: unknown,
  goals: readonly string[],
): Result<readonly { readonly taskId: TaskId; readonly objective: string }[], TaskDecomposeError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(taskError("malformed", "proposed"));
  }
  if (value.length > MAX_BOUNDED_TASKS) {
    return err(taskError("oversized", "proposed"));
  }
  const items: { readonly taskId: TaskId; readonly objective: string }[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const parsed = proposedSchema.safeParse(entry);
    if (!parsed.success) {
      return err(taskError("malformed", `proposed.${index}`));
    }
    const objective = parseBoundedText(
      parsed.data.objective,
      `proposed.${index}.objective`,
      MAX_GOAL_BYTES,
    );
    if (!objective.ok) {
      return objective;
    }
    if (!goals.includes(objective.value)) {
      return err(taskError("scope-growth", `proposed.${index}.objective`));
    }
    if (seenIds.has(parsed.data.taskId)) {
      return err(taskError("malformed", `proposed.${index}.taskId`));
    }
    seenIds.add(parsed.data.taskId);
    items.push({ taskId: parsed.data.taskId, objective: objective.value });
  }
  return ok(items);
}

function autoTaskId(index: number): Result<TaskId, TaskDecomposeError> {
  const parsed = taskId.parse(`t${index + 1}`);
  return parsed.ok ? parsed : err(taskError("malformed", `tasks.${index}.taskId`));
}

/**
 * Turns a declared outcome into one bounded task per goal.
 *
 * When `proposed` is omitted, each goal becomes a task. When it is present,
 * every proposed objective must be an exact declared goal — extras are
 * `scope-growth`, not silent work.
 */
export function decomposeUserOutcome(
  input: TaskDecomposeInput,
  signal?: AbortSignal,
): Result<TaskDecomposition, TaskDecomposeError> {
  if (signal?.aborted) {
    return err(taskError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(taskError("unsupported", "model"));
  }
  const id = outcomeId.parse(input.outcomeId);
  if (!id.ok) {
    return err(taskError("malformed", "outcomeId"));
  }
  const statement = parseBoundedText(input.statement, "statement", MAX_OUTCOME_STATEMENT_BYTES);
  if (!statement.ok) {
    return statement;
  }
  const goals = parseTextList(input.goals, "goals", MAX_GOALS, true);
  if (!goals.ok) {
    return goals;
  }
  const nonGoals = parseTextList(input.nonGoals, "nonGoals", MAX_NON_GOALS, false);
  if (!nonGoals.ok) {
    return nonGoals;
  }
  const proposed = parseProposed(input.proposed, goals.value);
  if (!proposed.ok) {
    return proposed;
  }
  const selected =
    proposed.value.length === 0 ? goals.value.map((goal) => ({ objective: goal })) : proposed.value;
  if (selected.length > MAX_BOUNDED_TASKS) {
    return err(taskError("oversized", "tasks"));
  }
  const tasks: BoundedTask[] = [];
  const covered = new Set<string>();
  for (const [index, item] of selected.entries()) {
    const assignedId = "taskId" in item ? ok(item.taskId) : autoTaskId(index);
    if (!assignedId.ok) {
      return assignedId;
    }
    if (covered.has(item.objective)) {
      return err(taskError("malformed", `tasks.${index}`));
    }
    covered.add(item.objective);
    tasks.push({
      taskId: assignedId.value,
      outcomeId: id.value,
      objective: item.objective,
      goal: item.objective,
      nonGoals: nonGoals.value,
    });
  }
  return ok({
    outcomeId: id.value,
    statement: statement.value,
    goals: goals.value,
    nonGoals: nonGoals.value,
    tasks,
    omittedGoals: goals.value.filter((goal) => !covered.has(goal)),
    provenance: {
      version: TASK_DECOMPOSE_VERSION,
      source: TASK_DECOMPOSE_SOURCE,
      model: null,
    },
  });
}
