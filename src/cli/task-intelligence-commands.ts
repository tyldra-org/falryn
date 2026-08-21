/**
 * Task decomposition, validation advice, and progress CLI (#726).
 *
 * `falryn task decompose` turns a declared outcome into bounded tasks.
 * `falryn task validate` recommends focused validation from declared criteria.
 * `falryn task progress` projects next actions from a graph and observations.
 * Each command is read-only advice: no Git, no execution, no mutation.
 */

import {
  decomposeOutcome,
  fromUnknown,
  projectOutcomeProgress,
  recommendOutcomeValidation,
} from "../application/index.ts";
import {
  describeTaskDecomposeError,
  describeTaskProgressError,
  describeTaskValidationError,
  type FalrynError,
  type TaskDecomposition,
  type TaskProgressProjection,
  type TaskValidationAdvice,
  type TerminalOutcome,
} from "../domain/index.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { TaskCommandArguments } from "./task-intelligence-parse.ts";
import { decomposeInputOf, progressInputOf, validateInputOf } from "./task-intelligence-parse.ts";

export const TASK_INTELLIGENCE_OWNER = "#726";

export type TaskDecomposePayload = {
  readonly owner: typeof TASK_INTELLIGENCE_OWNER;
  readonly decomposition: TaskDecomposition;
};

export type TaskValidatePayload = {
  readonly owner: typeof TASK_INTELLIGENCE_OWNER;
  readonly advice: TaskValidationAdvice;
};

export type TaskProgressPayload = {
  readonly owner: typeof TASK_INTELLIGENCE_OWNER;
  readonly projection: TaskProgressProjection;
};

function resultFor<Command extends CommandId, Payload>(
  command: Command,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
  outcome?: TerminalOutcome,
  effect: CommandEffect = READ_ONLY_EFFECT,
): CommandResultOf<Command, Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
    correlation: {
      workspaceId: null,
      sessionId: null,
      turnId: null,
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
  };
}

function decomposeFailure(error: Parameters<typeof describeTaskDecomposeError>[0]): FalrynError {
  return fromUnknown(new Error(describeTaskDecomposeError(error)), {
    operation: "decompose outcome",
  });
}

function validateFailure(error: Parameters<typeof describeTaskValidationError>[0]): FalrynError {
  return fromUnknown(new Error(describeTaskValidationError(error)), {
    operation: "recommend outcome validation",
  });
}

function progressFailure(error: Parameters<typeof describeTaskProgressError>[0]): FalrynError {
  return fromUnknown(new Error(describeTaskProgressError(error)), {
    operation: "project outcome progress",
  });
}

/** Decompose a declared outcome into bounded tasks. */
export function runTaskDecompose(
  arguments_: Extract<TaskCommandArguments, { readonly action: "decompose" }>,
  signal?: AbortSignal,
): CommandResultOf<"task.decompose", TaskDecomposePayload> {
  const result = decomposeOutcome(decomposeInputOf(arguments_.input), signal);
  if (!result.ok) {
    return resultFor("task.decompose", null, [decomposeFailure(result.error)]);
  }
  return resultFor("task.decompose", {
    owner: TASK_INTELLIGENCE_OWNER,
    decomposition: result.value,
  });
}

/** Recommend focused validation from declared completion criteria. */
export function runTaskValidate(
  arguments_: Extract<TaskCommandArguments, { readonly action: "validate" }>,
  signal?: AbortSignal,
): CommandResultOf<"task.validate", TaskValidatePayload> {
  const result = recommendOutcomeValidation(validateInputOf(arguments_.input), signal);
  if (!result.ok) {
    return resultFor("task.validate", null, [validateFailure(result.error)]);
  }
  return resultFor("task.validate", {
    owner: TASK_INTELLIGENCE_OWNER,
    advice: result.value,
  });
}

/** Project progress, recovery advice, and next actions. */
export function runTaskProgress(
  arguments_: Extract<TaskCommandArguments, { readonly action: "progress" }>,
  signal?: AbortSignal,
): CommandResultOf<"task.progress", TaskProgressPayload> {
  const result = projectOutcomeProgress(progressInputOf(arguments_.input), signal);
  if (!result.ok) {
    return resultFor("task.progress", null, [progressFailure(result.error)]);
  }
  return resultFor("task.progress", {
    owner: TASK_INTELLIGENCE_OWNER,
    projection: result.value,
  });
}

/** Summarize a decomposition for a short TUI notice. */
export function summarizeTaskDecomposition(decomposition: TaskDecomposition): string {
  const tasks = decomposition.tasks.map((task) => task.objective).join("; ");
  const omitted =
    decomposition.omittedGoals.length > 0
      ? ` Omitted goals: ${decomposition.omittedGoals.join(", ")}.`
      : "";
  return `${decomposition.tasks.length} task(s): ${tasks}.${omitted}`;
}

/** Summarize validation advice for a short TUI notice. */
export function summarizeTaskValidation(advice: TaskValidationAdvice): string {
  return `${advice.recommendations.length} recommendation(s); ${advice.omittedTasks.length} task(s) omitted without criteria.`;
}

/** Summarize progress projection for a short TUI notice. */
export function summarizeTaskProgress(projection: TaskProgressProjection): string {
  const actions = projection.nextActions
    .map((action) => `${action.kind} ${action.taskId}`)
    .join(", ");
  return `Overall ${projection.overall}; next: ${actions || "none"}.`;
}
