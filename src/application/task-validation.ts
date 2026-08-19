/**
 * Application boundary for focused validation advice (#125).
 *
 * Secret-shaped criterion text fails closed. The recommendations are advice:
 * this module still does not run tests, talk to Git, or call a model.
 */

import {
  err,
  type Result,
  recommendTaskValidation,
  type TaskValidationAdvice,
  type TaskValidationError,
  type TaskValidationInput,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function validationError(
  code: TaskValidationError["code"],
  field: string | null,
): TaskValidationError {
  return { kind: "task-validation", code, field };
}

export function recommendOutcomeValidation(
  input: TaskValidationInput,
  signal?: AbortSignal,
): Result<TaskValidationAdvice, TaskValidationError> {
  if (!Array.isArray(input.tasks)) {
    return recommendTaskValidation(input, signal);
  }
  for (const [index, entry] of input.tasks.entries()) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const criteria = (entry as { criteria?: unknown }).criteria;
    if (!Array.isArray(criteria)) {
      continue;
    }
    for (const [criterionIndex, criterion] of criteria.entries()) {
      if (typeof criterion === "string" && containsRedactableSecret(criterion)) {
        return err(validationError("secret", `tasks.${index}.criteria.${criterionIndex}`));
      }
    }
  }
  return recommendTaskValidation(input, signal);
}
