/**
 * Product memory tools and turn-end admission (#720).
 */

import { describe, expect, test } from "bun:test";

import { configurationGeneration, turnId, workspaceId } from "../domain/index.ts";
import { composeProductMemoryTurn } from "./product-memory-turn.ts";
import { composeProductMemoryTools, PRODUCT_MEMORY_TOOLS_OWNER } from "./product-tools-memory.ts";

describe("composeProductMemoryTools", () => {
  test("registers admit and recall tools", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
    });
    expect(tools.owner).toBe(PRODUCT_MEMORY_TOOLS_OWNER);
    expect(tools.toolNames).toEqual(["memory_admit", "memory_recall"]);
  });
});

describe("composeProductMemoryTurn", () => {
  test("recalls before the prompt and admits only after a completed terminal turn", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
    });
    const turn = composeProductMemoryTurn({
      admission: tools.admission,
      recall: tools.recall,
    });
    const before = turn.recallBeforeTurn({
      workspaceId: workspaceId.from("workspace-1"),
      task: "Prefer main as the default branch.",
    });
    expect(before.ok && before.value.recalledCount).toBe(0);

    const ended = turn.admitAfterTurn({
      turnId: turnId.from("turn-1"),
      workspaceId: workspaceId.from("workspace-1"),
      task: "Prefer main as the default branch.",
      outcome: { kind: "completed" },
    });
    expect(ended.ok).toBe(true);
    if (!ended.ok) {
      return;
    }
    expect(ended.value.admittedId).toBe("mem-turn-1");
    expect(ended.value.admitted).toBe(true);

    const after = turn.recallBeforeTurn({
      workspaceId: workspaceId.from("workspace-1"),
      task: "default branch main",
    });
    expect(after.ok && after.value.recalledCount).toBeGreaterThan(0);
    expect(after.ok && after.value.memorySection?.role).toBe("memory");

    const failed = turn.admitAfterTurn({
      turnId: turnId.from("turn-2"),
      workspaceId: workspaceId.from("workspace-1"),
      task: "unfinished work",
      outcome: { kind: "failed", effect: "none" },
    });
    expect(failed.ok && failed.value.admittedId).toBeNull();
  });
});
