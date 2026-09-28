/**
 * Product memory tools and turn-end admission (#720).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { configurationGeneration, turnId, workspaceId } from "../../domain/foundation/index.ts";
import { isClosedProductToolSchema } from "../tools/product-tool-schema.ts";
import {
  composeProductMemoryTools,
  PRODUCT_MEMORY_TOOLS_OWNER,
} from "../tools/product-tools-memory.ts";
import { composeProductMemoryTurn } from "./product-memory-turn.ts";

const record = {
  memoryId: "mem-1",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  kind: "project-fact",
  subject: "Default branch",
  content: "The default branch is main.",
  provenance: [{ origin: "user-request", locator: "turn:1" }],
  confidence: 90,
  createdAt: "2025-01-01T00:00:00.000Z",
};

describe("composeProductMemoryTools", () => {
  test("registers admit and recall tools", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
      workspaceId: "workspace-1",
    });
    expect(tools.owner).toBe(PRODUCT_MEMORY_TOOLS_OWNER);
    expect(tools.toolNames).toEqual(["memory_admit", "memory_recall"]);
  });

  test("publishes closed model-boundary schemas for admit and recall", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
      workspaceId: "workspace-1",
    });
    const schema = (name: string) => {
      const entry = tools.registry.resolveByName(name);
      if (!entry) throw new Error(`missing ${name}`);
      return entry.manifest.inputSchema;
    };

    const admit = schema("memory_admit");
    const recall = schema("memory_recall");
    expect(isClosedProductToolSchema(z.toJSONSchema(admit))).toBe(true);
    expect(isClosedProductToolSchema(z.toJSONSchema(recall))).toBe(true);

    expect(admit.safeParse({ record }).success).toBe(true);
    expect(admit.safeParse({ record, context: { sourceTrust: "user-confirmed" } }).success).toBe(
      false,
    );
    expect(admit.safeParse({ record: { ...record, confidence: 200 } }).success).toBe(false);
    expect(admit.safeParse({ record: { ...record, provenance: [] } }).success).toBe(false);
    expect(recall.safeParse({}).success).toBe(true);
    expect(recall.safeParse({ query: null, maxResults: 4 }).success).toBe(true);
    expect(recall.safeParse({ workspaceId: "other" }).success).toBe(false);
    expect(recall.safeParse({ destination: "sensitive" }).success).toBe(false);
    expect(recall.safeParse({ now: "2000-01-01" }).success).toBe(false);
    expect(recall.safeParse({ maxResults: 0 }).success).toBe(false);
  });
});

describe("composeProductMemoryTurn", () => {
  test("a settled committed turn wakes reflection and admits nothing by itself", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
      workspaceId: "workspace-1",
    });
    const wakes: number[] = [];
    const turn = composeProductMemoryTurn({
      recall: tools.recall,
      reflection: {
        wake: ({ throughSequence }) => {
          wakes.push(throughSequence);
          return "accepted";
        },
      },
    });
    const before = turn.recallBeforeTurn({
      workspaceId: workspaceId.from("workspace-1"),
      task: "Prefer main as the default branch.",
    });
    expect(before.ok && before.value.recalledCount).toBe(0);
    expect(turn.reflectAfterTurn({ turnId: turnId.from("turn-1"), committedThrough: 7 })).toBe(
      "requested",
    );
    expect(wakes).toEqual([7]);
    // The task text is no longer admitted as memory at turn end.
    const after = turn.recallBeforeTurn({
      workspaceId: workspaceId.from("workspace-1"),
      task: "default branch main",
    });
    expect(after.ok && after.value.recalledCount).toBe(0);
    // Without a committed boundary or a reflection store, nothing is requested.
    expect(turn.reflectAfterTurn({ turnId: turnId.from("turn-2"), committedThrough: null })).toBe(
      "unavailable",
    );
    expect(
      composeProductMemoryTurn({ recall: tools.recall }).reflectAfterTurn({
        turnId: turnId.from("turn-3"),
        committedThrough: 9,
      }),
    ).toBe("unavailable");
    expect(wakes).toEqual([7]);
  });
});
