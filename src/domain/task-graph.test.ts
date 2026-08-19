/**
 * Static task graph: dependencies, blockers, joins, completion criteria.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { outcomeId, taskId } from "./identity.ts";
import {
  describeTaskGraphError,
  planTaskGraph,
  TASK_GRAPH_SOURCE,
  TASK_GRAPH_VERSION,
} from "./task-graph.ts";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    outcomeId: "outcome-1",
    tasks: ["t1", "t2"],
    ...overrides,
  };
}

describe("planTaskGraph", () => {
  test("marks independent tasks ready with default join all", () => {
    const result = planTaskGraph(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.outcomeId).toBe(outcomeId.from("outcome-1"));
    expect(result.value.nodes.map((node) => node.readiness)).toEqual(["ready", "ready"]);
    expect(result.value.nodes[0]?.join).toBe("all");
    expect(result.value.provenance).toEqual({
      version: TASK_GRAPH_VERSION,
      source: TASK_GRAPH_SOURCE,
      model: null,
    });
  });

  test("records a predecessor and marks the successor waiting", () => {
    const result = planTaskGraph(
      baseInput({
        dependencies: [{ predecessor: "t1", successor: "t2" }],
        joins: [{ taskId: "t2", policy: "any" }],
        criteria: [{ taskId: "t2", criterion: "Restore succeeds from the package" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.nodes[0]?.readiness).toBe("ready");
    expect(result.value.nodes[1]?.dependsOn).toEqual([taskId.from("t1")]);
    expect(result.value.nodes[1]?.join).toBe("any");
    expect(result.value.nodes[1]?.completionCriteria).toEqual([
      "Restore succeeds from the package",
    ]);
    expect(result.value.nodes[1]?.readiness).toBe("waiting");
  });

  test("marks a task blocked when an external impediment is declared", () => {
    const result = planTaskGraph(
      baseInput({
        dependencies: [{ predecessor: "t1", successor: "t2" }],
        blockers: [{ taskId: "t2", reason: "Missing restore fixture" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.nodes[1]?.readiness).toBe("blocked");
    expect(result.value.nodes[1]?.blockers).toEqual(["Missing restore fixture"]);
  });

  test("refuses a dependency cycle", () => {
    const result = planTaskGraph(
      baseInput({
        dependencies: [
          { predecessor: "t1", successor: "t2" },
          { predecessor: "t2", successor: "t1" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({ kind: "task-graph", code: "cycle", field: "dependencies" });
    expect(describeTaskGraphError(result.error)).toBe("cycle dependencies");
  });

  test("refuses an edge that names a task outside the graph", () => {
    const result = planTaskGraph(
      baseInput({
        dependencies: [{ predecessor: "t9", successor: "t1" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
    expect(JSON.stringify(result)).not.toContain("t9");
  });

  test("refuses extra fields on a dependency object", () => {
    const result = planTaskGraph(
      baseInput({
        dependencies: [{ predecessor: "t1", successor: "t2", execute: true }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a model-assisted graph", () => {
    const result = planTaskGraph(baseInput({ model: "small-classifier" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "task-graph", code: "unsupported", field: "model" });
    }
  });

  test("treats cancellation as cancelled, not as a completed graph", () => {
    const result = planTaskGraph(baseInput(), AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, or git port", async () => {
    const source = await readFile(new URL("./task-graph.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /\b(CommandRunnerPort|ProviderPort|GitPort|Bun\.spawn|child_process|fetch\()\b/,
    );
  });
});
