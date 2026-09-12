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
    });
    expect(tools.owner).toBe(PRODUCT_MEMORY_TOOLS_OWNER);
    expect(tools.toolNames).toEqual(["memory_admit", "memory_recall"]);
  });

  test("publishes closed model-boundary schemas for admit and recall", () => {
    const tools = composeProductMemoryTools({
      generation: configurationGeneration.from(0),
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

    expect(
      admit.safeParse({
        record,
        context: {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: "workspace-1",
        },
      }).success,
    ).toBe(true);
    expect(
      admit.safeParse({
        record: { ...record, scope: { kind: "repository", workspaceId: "w", locator: "r" } },
        context: {
          sourceKind: "reflection",
          sourceTrust: "inferred",
          workspaceId: "workspace-1",
        },
      }).success,
    ).toBe(true);
    expect(admit.safeParse({ record }).success).toBe(false);
    expect(
      admit.safeParse({
        record: { ...record, provenance: [] },
        context: {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: "workspace-1",
        },
      }).success,
    ).toBe(false);
    expect(
      admit.safeParse({
        record: { ...record, confidence: 200 },
        context: {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: "workspace-1",
        },
      }).success,
    ).toBe(false);
    expect(
      admit.safeParse({
        record: { ...record, scope: { kind: "repository", workspaceId: "w" } },
        context: {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: "workspace-1",
        },
      }).success,
    ).toBe(false);
    expect(
      admit.safeParse({
        record,
        context: {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: "workspace-1",
        },
        signal: "x",
      }).success,
    ).toBe(false);

    expect(recall.safeParse({ workspaceId: "workspace-1" }).success).toBe(true);
    expect(recall.safeParse({ workspaceId: "workspace-1", query: null }).success).toBe(true);
    expect(
      recall.safeParse({
        workspaceId: "workspace-1",
        destination: "sensitive",
        maxResults: 4,
      }).success,
    ).toBe(true);
    expect(recall.safeParse({}).success).toBe(false);
    expect(recall.safeParse({ workspaceId: "workspace-1", maxResults: 0 }).success).toBe(false);
    expect(recall.safeParse({ workspaceId: "workspace-1", destination: "secret" }).success).toBe(
      false,
    );
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
