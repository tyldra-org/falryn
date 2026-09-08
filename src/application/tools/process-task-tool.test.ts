import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createProcessTaskToolEntry,
  PROCESS_TASK_CONTROL_CAPABILITY,
} from "./process-task-tool.ts";
import { isClosedProductToolSchema } from "./product-tool-schema.ts";

const handle = { version: 1, taskId: "task-fixture", generation: "generation-fixture" };

describe("process_task declaration", () => {
  test("uses a closed provider object schema with operation-specific runtime validation", () => {
    const entry = createProcessTaskToolEntry();
    expect(String(entry.manifest.capabilityId)).toBe(PROCESS_TASK_CONTROL_CAPABILITY);
    const schema = z.toJSONSchema(entry.manifest.inputSchema);
    expect(schema.type).toBe("object");
    expect(isClosedProductToolSchema(schema)).toBe(true);
    expect(entry.manifest.inputSchema.safeParse({ ...handle, operation: "inspect" }).success).toBe(
      true,
    );
    expect(
      entry.manifest.inputSchema.safeParse({ ...handle, operation: "inspect", limit: 1 }).success,
    ).toBe(false);
    expect(entry.manifest.inputSchema.safeParse({ ...handle, operation: "kill" }).success).toBe(
      false,
    );
    expect(
      entry.manifest.inputSchema.safeParse({ ...handle, operation: "kill", expectedRevision: 1 })
        .success,
    ).toBe(true);
    expect(
      entry.manifest.inputSchema.safeParse({
        ...handle,
        operation: "result",
        offset: 32_768,
        limit: 32_768,
      }).success,
    ).toBe(true);
    expect(
      entry.manifest.inputSchema.safeParse({
        ...handle,
        operation: "logs",
        stream: "stdout",
        offset: 0,
        limit: 32_769,
      }).success,
    ).toBe(false);
    expect(
      entry.manifest.inputSchema.safeParse({ ...handle, operation: "launch", argv: [] }).success,
    ).toBe(false);
  });

  test("termination is a mutation, with a control lock distinct from workspace effects", () => {
    const entry = createProcessTaskToolEntry();
    const read = entry.manifest.inputSchema.parse({ ...handle, operation: "inspect" });
    const stop = entry.manifest.inputSchema.parse({
      ...handle,
      operation: "cancel",
      expectedRevision: 1,
    });
    expect(entry.manifest.effectFor?.(read)).toBe("observation");
    expect(entry.manifest.effectFor?.(stop)).toBe("mutation");
    expect(entry.manifest.conflictKeysFor?.(stop).map(String)).toEqual([
      "process-task-control:task-fixture:generation-fixture",
    ]);
    expect(entry.manifest.limits.maxOutputBytes).toBe(65_536);
  });
});
