/**
 * Application boundary for a static task graph (#124).
 *
 * Secret-shaped blocker or criterion text fails closed. The graph is advice:
 * this module still does not execute a task, talk to Git, or call a model.
 */

import {
  err,
  ok,
  planTaskGraph,
  type Result,
  type TaskGraph,
  type TaskGraphError,
  type TaskGraphInput,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function graphError(code: TaskGraphError["code"], field: string | null): TaskGraphError {
  return { kind: "task-graph", code, field };
}

function secretInObjectList(
  value: unknown,
  field: string,
  keys: readonly string[],
): Result<null, TaskGraphError> {
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
        return err(graphError("secret", `${field}.${index}.${key}`));
      }
    }
  }
  return ok(null);
}

export function planOutcomeTaskGraph(
  input: TaskGraphInput,
  signal?: AbortSignal,
): Result<TaskGraph, TaskGraphError> {
  const blockers = secretInObjectList(input.blockers, "blockers", ["reason"]);
  if (!blockers.ok) {
    return blockers;
  }
  const criteria = secretInObjectList(input.criteria, "criteria", ["criterion"]);
  if (!criteria.ok) {
    return criteria;
  }
  return planTaskGraph(input, signal);
}
