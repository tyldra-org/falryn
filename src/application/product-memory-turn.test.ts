/**
 * Product memory tools and turn-end admission (#720).
 */

import { describe, expect, test } from "bun:test";

import { configurationGeneration, sessionId, turnId, workspaceId } from "../domain/index.ts";
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
  test("admits turn text and recalls into a memory prompt section", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
    });
    const turn = composeProductMemoryTurn({
      admission: tools.admission,
      recall: tools.recall,
    });
    const ended = turn.endTurn({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      task: "Prefer main as the default branch.",
    });
    expect(ended.ok).toBe(true);
    if (!ended.ok) {
      return;
    }
    expect(ended.value.admittedId).toBe("mem-turn-1");
    expect(ended.value.recalledCount).toBeGreaterThan(0);
    expect(ended.value.memorySection?.role).toBe("memory");
  });
});
