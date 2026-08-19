/**
 * Progress, partial completion, recovery, and next-action projection.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { outcomeId, taskId } from "./identity.ts";
import {
  projectTaskProgress,
  TASK_PROGRESS_SOURCE,
  TASK_PROGRESS_VERSION,
} from "./task-progress.ts";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    outcomeId: "outcome-1",
    tasks: ["t1", "t2"],
    dependencies: [{ predecessor: "t1", successor: "t2" }],
    ...overrides,
  };
}

describe("projectTaskProgress", () => {
  test("starts independent work and keeps a successor waiting until its join completes", () => {
    const result = projectTaskProgress(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.outcomeId).toBe(outcomeId.from("outcome-1"));
    expect(result.value.overall).toBe("pending");
    expect(result.value.nodes).toEqual([
      { taskId: taskId.from("t1"), state: "pending", joinSatisfied: true },
      { taskId: taskId.from("t2"), state: "pending", joinSatisfied: false },
    ]);
    expect(result.value.nextActions).toEqual([
      {
        kind: "start",
        taskId: taskId.from("t1"),
        statement: "Start task t1",
      },
    ]);
    expect(result.value.omittedTasks).toEqual([taskId.from("t1"), taskId.from("t2")]);
    expect(result.value.provenance).toEqual({
      version: TASK_PROGRESS_VERSION,
      source: TASK_PROGRESS_SOURCE,
      model: null,
    });
  });

  test("projects partial completion and the next startable successor", () => {
    const result = projectTaskProgress(
      baseInput({
        observations: [{ taskId: "t1", status: "completed" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.overall).toBe("partial");
    expect(result.value.nodes[0]?.state).toBe("complete");
    expect(result.value.nextActions).toEqual([
      {
        kind: "start",
        taskId: taskId.from("t2"),
        statement: "Start task t2",
      },
    ]);
  });

  test("refuses observed completion that skips an unsatisfied join", () => {
    const result = projectTaskProgress(
      baseInput({
        observations: [{ taskId: "t2", status: "completed" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("stale");
    }
  });

  test("recovers a failed task without treating it complete", () => {
    const result = projectTaskProgress(
      baseInput({
        observations: [{ taskId: "t1", status: "failed" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.overall).toBe("failed");
    expect(result.value.nextActions.map((action) => action.kind)).toEqual(["retry"]);
    expect(result.value.nodes[0]?.state).toBe("failed");
  });

  test("refuses a model-assisted projection", () => {
    const result = projectTaskProgress(baseInput({ model: "small-classifier" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported");
    }
  });

  test("treats cancellation as cancelled, not as completed progress", () => {
    const result = projectTaskProgress(baseInput(), AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./task-progress.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|Bun\.spawn|child_process|fetch\(|git add|git commit)\b/,
    );
  });
});
