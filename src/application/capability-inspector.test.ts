import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  configurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  inspectCapabilityHealth,
} from "../domain/index.ts";
import { createCapabilityInspector } from "./capability-inspector.ts";

function capability(name: string, overrides: Partial<CapabilityRegistryDocument> = {}) {
  const document: CapabilityRegistryDocument = {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    kind: "tool",
    title: name,
    summary: `Use ${name}`,
    family: "read",
    effect: "observation",
    provenance: { sourceId: "builtin:workspace", sourceVersion: "1" },
    compatibility: { os: [], arch: [], dependencies: [] },
    limits: {
      maxInputBytes: null,
      maxOutputBytes: null,
      defaultTimeoutMs: null,
      maxConcurrency: null,
    },
    routing: { costClass: "unknown", latencyClass: "unknown" },
    state: {
      availability: "available",
      availabilityReason: null,
      health: "healthy",
      healthReason: null,
      executable: true,
      executionReason: null,
      operational: defaultCapabilityOperationalState(),
    },
    schemas: { inputDigest: null, outputDigest: null },
    ...overrides,
  };
  const created = createCapabilityRegistryEntry(document);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe("capability inspector", () => {
  test("projects tools, permissions, and doctor from the exact same snapshot", () => {
    const read = capability("read_file");
    const write = capability("write_files", {
      family: "edit",
      effect: "mutation",
      state: {
        availability: "available",
        availabilityReason: null,
        health: "healthy",
        healthReason: null,
        executable: true,
        executionReason: null,
        operational: defaultCapabilityOperationalState({ allowed: false, denied: true }),
      },
    });
    const registry = createCapabilityRegistry(configurationGeneration.from(9), [read, write]);
    if (!registry.ok) throw new Error(registry.error.code);
    const snapshot = inspectCapabilityHealth(registry.value, "cli");
    const inspector = createCapabilityInspector(snapshot);

    const tools = inspector.tools({ health: ["denied"] });
    expect(tools.ok).toBe(true);
    if (!tools.ok) return;
    expect(tools.value.result.entries.map((entry) => entry.capabilityId)).toEqual([
      write.capabilityId,
    ]);
    expect(inspector.permissions().effects).toContainEqual({
      effect: "mutation",
      allowed: false,
      registered: 1,
      selectable: 0,
      denied: 1,
      unavailable: 1,
    });
    expect(inspector.doctor()).toMatchObject({
      healthy: false,
      readOnly: true,
      findings: [{ code: "policy-denied", count: 1 }],
    });
  });

  test("rejects stale queries without mutating the snapshot", () => {
    const registry = createCapabilityRegistry(configurationGeneration.from(3), [
      capability("read_file"),
    ]);
    if (!registry.ok) throw new Error(registry.error.code);
    const inspector = createCapabilityInspector(inspectCapabilityHealth(registry.value, "opentui"));

    expect(inspector.tools({ generation: configurationGeneration.from(2) })).toEqual({
      ok: false,
      error: { code: "stale-generation", reason: "stale-generation" },
    });
    expect(inspector.doctor().healthy).toBe(true);
  });
});
