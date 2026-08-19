/**
 * Application boundary for bounded task decomposition (#123).
 *
 * Secret-shaped outcome text fails closed. The decomposition is advice: this
 * module still does not execute a task, talk to Git, or call a model.
 */

import {
  decomposeUserOutcome,
  err,
  ok,
  type Result,
  type TaskDecomposeError,
  type TaskDecomposeInput,
  type TaskDecomposition,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function taskError(code: TaskDecomposeError["code"], field: string | null): TaskDecomposeError {
  return { kind: "task-decompose", code, field };
}

function secretInList(value: unknown, field: string): Result<null, TaskDecomposeError> {
  if (!Array.isArray(value)) {
    return ok(null);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string" && containsRedactableSecret(entry)) {
      return err(taskError("secret", `${field}.${index}`));
    }
  }
  return ok(null);
}

export function decomposeOutcome(
  input: TaskDecomposeInput,
  signal?: AbortSignal,
): Result<TaskDecomposition, TaskDecomposeError> {
  if (typeof input.statement === "string" && containsRedactableSecret(input.statement)) {
    return err(taskError("secret", "statement"));
  }
  const goals = secretInList(input.goals, "goals");
  if (!goals.ok) {
    return goals;
  }
  const nonGoals = secretInList(input.nonGoals, "nonGoals");
  if (!nonGoals.ok) {
    return nonGoals;
  }
  return decomposeUserOutcome(input, signal);
}
