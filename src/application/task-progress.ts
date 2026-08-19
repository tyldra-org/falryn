/**
 * Application boundary for task-progress projection (#127).
 *
 * Secret-shaped observation notes, blockers, and criteria fail closed. The
 * projection is advice: this module still does not execute a task or mark one
 * complete.
 */

import {
  err,
  ok,
  projectTaskProgress,
  type Result,
  type TaskProgressError,
  type TaskProgressInput,
  type TaskProgressProjection,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function progressError(code: TaskProgressError["code"], field: string | null): TaskProgressError {
  return { kind: "task-progress", code, field };
}

function secretInObjectList(
  value: unknown,
  field: string,
  keys: readonly string[],
): Result<null, TaskProgressError> {
  if (!Array.isArray(value)) {
    return ok(null);
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && containsRedactableSecret(candidate)) {
        return err(progressError("secret", `${field}.${index}.${key}`));
      }
    }
  }
  return ok(null);
}

export function projectOutcomeProgress(
  input: TaskProgressInput,
  signal?: AbortSignal,
): Result<TaskProgressProjection, TaskProgressError> {
  const blockers = secretInObjectList(input.blockers, "blockers", ["reason"]);
  if (!blockers.ok) {
    return blockers;
  }
  const criteria = secretInObjectList(input.criteria, "criteria", ["criterion"]);
  if (!criteria.ok) {
    return criteria;
  }
  const observations = secretInObjectList(input.observations, "observations", ["note"]);
  if (!observations.ok) {
    return observations;
  }
  return projectTaskProgress(input, signal);
}
