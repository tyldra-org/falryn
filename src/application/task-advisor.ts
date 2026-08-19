/**
 * Application boundary for bounded review, advisor, and simplify (#285).
 *
 * Secret-shaped question, excerpt, rubric, or proposal text fails closed.
 * The result is advice: this module still does not mutate or call a model.
 */

import {
  adviseTask,
  err,
  ok,
  type Result,
  type TaskAdvisorAdvice,
  type TaskAdvisorError,
  type TaskAdvisorInput,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function advisorError(code: TaskAdvisorError["code"], field: string | null): TaskAdvisorError {
  return { kind: "task-advisor", code, field };
}

function secretInString(value: unknown, field: string): Result<null, TaskAdvisorError> {
  if (typeof value === "string" && containsRedactableSecret(value)) {
    return err(advisorError("secret", field));
  }
  return ok(null);
}

function secretInList(value: unknown, field: string): Result<null, TaskAdvisorError> {
  if (!Array.isArray(value)) {
    return ok(null);
  }
  for (const [index, entry] of value.entries()) {
    const found = secretInString(entry, `${field}.${index}`);
    if (!found.ok) {
      return found;
    }
  }
  return ok(null);
}

function secretInObjectList(
  value: unknown,
  field: string,
  keys: readonly string[],
): Result<null, TaskAdvisorError> {
  if (!Array.isArray(value)) {
    return ok(null);
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    for (const key of keys) {
      const found = secretInString(record[key], `${field}.${index}.${key}`);
      if (!found.ok) {
        return found;
      }
    }
  }
  return ok(null);
}

export function adviseOutcome(
  input: TaskAdvisorInput,
  signal?: AbortSignal,
): Result<TaskAdvisorAdvice, TaskAdvisorError> {
  const question = secretInString(input.question, "question");
  if (!question.ok) {
    return question;
  }
  const evidence = secretInObjectList(input.evidence, "evidence", ["id", "location", "excerpt"]);
  if (!evidence.ok) {
    return evidence;
  }
  const rubric = secretInList(input.rubric, "rubric");
  if (!rubric.ok) {
    return rubric;
  }
  const proposed = secretInObjectList(input.proposed, "proposed", ["path", "summary"]);
  if (!proposed.ok) {
    return proposed;
  }
  return adviseTask(input, signal);
}
