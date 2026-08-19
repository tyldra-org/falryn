/**
 * Recommend focused validation and negative controls (#125).
 *
 * Advice only: one confirmation and one negative control per declared
 * completion criterion. This module does not run tests, execute Git, mark a
 * task complete, or invent undeclared work.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import {
  type OutcomeId,
  outcomeId,
  type RecommendationId,
  recommendationId,
  type TaskId,
  taskId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const TASK_VALIDATION_VERSION = "task-validation.v1";
export const TASK_VALIDATION_SOURCE = "deterministic-criteria";
export const MAX_VALIDATION_TASKS = 16;
export const MAX_CRITERIA_PER_TASK = 16;
export const MAX_CRITERION_BYTES = 512;
export const MAX_VALIDATION_RECOMMENDATIONS = MAX_VALIDATION_TASKS * MAX_CRITERIA_PER_TASK * 2;

export const TASK_VALIDATION_KINDS = ["focused-validation", "negative-control"] as const;
export type TaskValidationKind = (typeof TASK_VALIDATION_KINDS)[number];

export type TaskValidationErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "unsupported";

export type TaskValidationError = {
  readonly kind: "task-validation";
  readonly code: TaskValidationErrorCode;
  readonly field: string | null;
};

export type TaskValidationProvenance = {
  readonly version: typeof TASK_VALIDATION_VERSION;
  readonly source: typeof TASK_VALIDATION_SOURCE;
  readonly model: null;
};

export type TaskValidationRecommendation = {
  readonly recommendationId: RecommendationId;
  readonly taskId: TaskId;
  readonly kind: TaskValidationKind;
  readonly statement: string;
  readonly criterion: string;
};

export type TaskValidationAdvice = {
  readonly outcomeId: OutcomeId;
  readonly recommendations: readonly TaskValidationRecommendation[];
  readonly omittedTasks: readonly TaskId[];
  readonly provenance: TaskValidationProvenance;
};

export type TaskValidationInput = {
  readonly outcomeId: unknown;
  readonly tasks: unknown;
  readonly model?: unknown;
};

const encoder = new TextEncoder();

function validationError(code: TaskValidationErrorCode, field: string | null): TaskValidationError {
  return { kind: "task-validation", code, field };
}

export function describeTaskValidationError(error: TaskValidationError): string {
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
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-validation error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, TaskValidationError> {
  if (typeof value !== "string") {
    return err(validationError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(validationError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(validationError("empty", field));
  }
  if (byteLength(trimmed) > maxBytes) {
    return err(validationError("oversized", field));
  }
  return ok(trimmed);
}

const taskSchema = z
  .object({
    taskId: brandedString(taskId),
    criteria: z.array(z.string()).optional(),
  })
  .strict();

function statementFor(kind: TaskValidationKind, criterion: string): string {
  switch (kind) {
    case "focused-validation":
      return `Confirm declared criterion: ${criterion}`;
    case "negative-control":
      return `Do not treat complete if undeclared work occurred beside: ${criterion}`;
    default:
      return assertNever(kind, "unhandled task-validation kind");
  }
}

function nextRecommendationId(index: number): Result<RecommendationId, TaskValidationError> {
  const parsed = recommendationId.parse(`v${index + 1}`);
  return parsed.ok
    ? parsed
    : err(validationError("malformed", `recommendations.${index}.recommendationId`));
}

/**
 * Turns declared completion criteria into focused validation and negative-control
 * advice. Tasks without criteria are reported in `omittedTasks` rather than
 * filled with invented checks.
 */
export function recommendTaskValidation(
  input: TaskValidationInput,
  signal?: AbortSignal,
): Result<TaskValidationAdvice, TaskValidationError> {
  if (signal?.aborted) {
    return err(validationError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(validationError("unsupported", "model"));
  }
  const id = outcomeId.parse(input.outcomeId);
  if (!id.ok) {
    return err(validationError("malformed", "outcomeId"));
  }
  if (!Array.isArray(input.tasks)) {
    return err(validationError("malformed", "tasks"));
  }
  if (input.tasks.length > MAX_VALIDATION_TASKS) {
    return err(validationError("oversized", "tasks"));
  }
  if (input.tasks.length === 0) {
    return err(validationError("empty", "tasks"));
  }

  const seen = new Set<string>();
  const omittedTasks: TaskId[] = [];
  const recommendations: TaskValidationRecommendation[] = [];

  for (const [index, entry] of input.tasks.entries()) {
    const parsed = taskSchema.safeParse(entry);
    if (!parsed.success) {
      return err(validationError("malformed", `tasks.${index}`));
    }
    if (seen.has(parsed.data.taskId)) {
      return err(validationError("malformed", `tasks.${index}.taskId`));
    }
    seen.add(parsed.data.taskId);
    const rawCriteria = parsed.data.criteria ?? [];
    if (rawCriteria.length > MAX_CRITERIA_PER_TASK) {
      return err(validationError("oversized", `tasks.${index}.criteria`));
    }
    const criteria: string[] = [];
    const seenCriteria = new Set<string>();
    for (const [criterionIndex, raw] of rawCriteria.entries()) {
      const criterion = parseBoundedText(
        raw,
        `tasks.${index}.criteria.${criterionIndex}`,
        MAX_CRITERION_BYTES,
      );
      if (!criterion.ok) {
        return criterion;
      }
      if (seenCriteria.has(criterion.value)) {
        return err(validationError("malformed", `tasks.${index}.criteria.${criterionIndex}`));
      }
      seenCriteria.add(criterion.value);
      criteria.push(criterion.value);
    }
    if (criteria.length === 0) {
      omittedTasks.push(parsed.data.taskId);
      continue;
    }
    for (const criterion of criteria) {
      for (const kind of TASK_VALIDATION_KINDS) {
        const recommendationIndex = recommendations.length;
        if (recommendationIndex >= MAX_VALIDATION_RECOMMENDATIONS) {
          return err(validationError("oversized", "recommendations"));
        }
        const assigned = nextRecommendationId(recommendationIndex);
        if (!assigned.ok) {
          return assigned;
        }
        recommendations.push({
          recommendationId: assigned.value,
          taskId: parsed.data.taskId,
          kind,
          statement: statementFor(kind, criterion),
          criterion,
        });
      }
    }
  }

  return ok({
    outcomeId: id.value,
    recommendations,
    omittedTasks,
    provenance: {
      version: TASK_VALIDATION_VERSION,
      source: TASK_VALIDATION_SOURCE,
      model: null,
    },
  });
}
