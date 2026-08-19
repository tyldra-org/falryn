/**
 * Focused validation and negative-control advice from declared criteria.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { recommendationId, taskId } from "./identity.ts";
import {
  recommendTaskValidation,
  TASK_VALIDATION_SOURCE,
  TASK_VALIDATION_VERSION,
} from "./task-validation.ts";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    outcomeId: "outcome-1",
    tasks: [{ taskId: "t1", criteria: ["Restore succeeds from the package"] }, { taskId: "t2" }],
    ...overrides,
  };
}

describe("recommendTaskValidation", () => {
  test("emits one confirmation and one negative control per criterion", () => {
    const result = recommendTaskValidation(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.recommendations).toHaveLength(2);
    expect(result.value.recommendations[0]).toMatchObject({
      recommendationId: recommendationId.from("v1"),
      taskId: taskId.from("t1"),
      kind: "focused-validation",
      criterion: "Restore succeeds from the package",
    });
    expect(result.value.recommendations[1]?.kind).toBe("negative-control");
    expect(result.value.omittedTasks).toEqual([taskId.from("t2")]);
    expect(result.value.provenance).toEqual({
      version: TASK_VALIDATION_VERSION,
      source: TASK_VALIDATION_SOURCE,
      model: null,
    });
  });

  test("refuses extra fields on a task object", () => {
    const result = recommendTaskValidation(
      baseInput({
        tasks: [{ taskId: "t1", criteria: ["Restore succeeds"], execute: true }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a model-assisted recommendation", () => {
    const result = recommendTaskValidation(baseInput({ model: "small-classifier" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "task-validation",
        code: "unsupported",
        field: "model",
      });
    }
  });

  test("treats cancellation as cancelled, not as completed advice", () => {
    const result = recommendTaskValidation(baseInput(), AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or test runner", async () => {
    const source = await readFile(new URL("./task-validation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|Bun\.spawn|child_process|fetch\(|bun test)\b/,
    );
  });
});
