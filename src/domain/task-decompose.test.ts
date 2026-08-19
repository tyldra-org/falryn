/**
 * Bounded task decomposition: declared goals only, no hidden scope.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { outcomeId, taskId } from "./identity.ts";
import {
  decomposeUserOutcome,
  describeTaskDecomposeError,
  MAX_GOAL_BYTES,
  MAX_GOALS,
  TASK_DECOMPOSE_SOURCE,
  TASK_DECOMPOSE_VERSION,
} from "./task-decompose.ts";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    outcomeId: "outcome-1",
    statement: "Ship a bounded export and a matching restore.",
    goals: ["Write the export package", "Restore from a verified package"],
    nonGoals: ["Execute Git", "Upload a support bundle"],
    ...overrides,
  };
}

describe("decomposeUserOutcome", () => {
  test("creates one task per declared goal", () => {
    const result = decomposeUserOutcome(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.outcomeId).toBe(outcomeId.from("outcome-1"));
    expect(result.value.tasks.map((task) => task.objective)).toEqual([
      "Write the export package",
      "Restore from a verified package",
    ]);
    expect(result.value.tasks[0]?.taskId).toBe(taskId.from("t1"));
    expect(result.value.tasks[0]?.nonGoals).toEqual(["Execute Git", "Upload a support bundle"]);
    expect(result.value.omittedGoals).toEqual([]);
    expect(result.value.provenance).toEqual({
      version: TASK_DECOMPOSE_VERSION,
      source: TASK_DECOMPOSE_SOURCE,
      model: null,
    });
  });

  test("accepts an explicit proposed split that names only declared goals", () => {
    const result = decomposeUserOutcome(
      baseInput({
        proposed: [
          { taskId: "export-write", objective: "Write the export package" },
          { taskId: "export-restore", objective: "Restore from a verified package" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.tasks[0]?.taskId).toBe(taskId.from("export-write"));
    expect(result.value.omittedGoals).toEqual([]);
  });

  test("reports omitted goals when the proposed split is partial", () => {
    const result = decomposeUserOutcome(
      baseInput({
        proposed: [{ taskId: "export-write", objective: "Write the export package" }],
      }),
    );
    expect(result.ok && result.value.omittedGoals).toEqual(["Restore from a verified package"]);
  });

  test("refuses a proposed task that is not a declared goal", () => {
    const result = decomposeUserOutcome(
      baseInput({
        proposed: [{ taskId: "rewrite-history", objective: "Force-push main" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({
      kind: "task-decompose",
      code: "scope-growth",
      field: "proposed.0.objective",
    });
    expect(describeTaskDecomposeError(result.error)).toBe("scope-growth proposed.0.objective");
    expect(JSON.stringify(result)).not.toContain("Force-push");
  });

  test("refuses a proposed object that carries extra fields", () => {
    const result = decomposeUserOutcome(
      baseInput({
        proposed: [
          {
            taskId: "export-write",
            objective: "Write the export package",
            children: [{ objective: "Also rewrite history" }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a model-assisted split", () => {
    const result = decomposeUserOutcome(baseInput({ model: "small-classifier" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: "task-decompose",
        code: "unsupported",
        field: "model",
      });
    }
  });

  test("refuses an empty outcome statement", () => {
    const result = decomposeUserOutcome(baseInput({ statement: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("empty");
    }
  });

  test("refuses more goals than the declared bound", () => {
    const result = decomposeUserOutcome(
      baseInput({
        goals: Array.from({ length: MAX_GOALS + 1 }, (_, index) => `Goal ${index + 1}`),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("oversized");
    }
  });

  test("refuses a goal past the byte bound", () => {
    const result = decomposeUserOutcome(baseInput({ goals: ["g".repeat(MAX_GOAL_BYTES + 1)] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("oversized");
    }
  });

  test("treats cancellation as cancelled, not as a completed split", () => {
    const result = decomposeUserOutcome(baseInput(), AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, or git port", async () => {
    const source = await readFile(new URL("./task-decompose.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|Bun\.spawn|child_process|fetch\()\b/,
    );
  });
});
