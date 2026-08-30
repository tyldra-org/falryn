import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  capabilityLifecycle,
  configurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  MAX_CAPABILITY_QUERY_LIMIT,
  parseCapabilityRegistryDocument,
  queryCapabilityRegistry,
  serializeCapabilityRegistry,
} from "./index.ts";

const digest = `sha-256:${"a".repeat(64)}`;

function document(
  name: string,
  overrides: Partial<CapabilityRegistryDocument> = {},
): CapabilityRegistryDocument {
  return {
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
      maxInputBytes: 1_024,
      maxOutputBytes: 4_096,
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
    schemas: { inputDigest: digest, outputDigest: digest },
    ...overrides,
  };
}

function entry(name: string, overrides: Partial<CapabilityRegistryDocument> = {}) {
  const result = createCapabilityRegistryEntry(document(name, overrides));
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("capability registry", () => {
  test("accepts distinct primitives without pretending they share an executor", () => {
    const contributions = [
      entry("read_file"),
      entry("issue_resource", {
        kind: "mcp-resource",
        source: "mcp",
        namespace: "github",
        family: "read",
        state: {
          ...document("unused").state,
          executable: false,
          executionReason: "resource is read through its owning MCP host",
        },
      }),
      entry("review_skill", {
        kind: "skill",
        source: "skill",
        namespace: "review",
        family: "capability",
        schemas: { inputDigest: null, outputDigest: null },
        state: {
          ...document("unused").state,
          executable: false,
          executionReason: "skill instructions load through the skill host",
        },
      }),
      entry("delivery_workflow", {
        kind: "workflow",
        source: "workflow",
        namespace: "delivery",
        family: "delegate",
        schemas: { inputDigest: null, outputDigest: null },
        state: {
          ...document("unused").state,
          executable: false,
          executionReason: "workflow engine unavailable",
        },
      }),
    ];
    const created = createCapabilityRegistry(configurationGeneration.from(4), contributions);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.entries.map((item) => item.kind)).toEqual([
      "tool",
      "mcp-resource",
      "skill",
      "workflow",
    ]);
    expect(created.value.entries.filter((item) => item.state.executable)).toHaveLength(1);
  });

  test("has no arbitrary installed-entry quota while keeping consumer queries bounded", () => {
    const entries = Array.from({ length: 600 }, (_, index) => entry(`tool_${index}`));
    const created = createCapabilityRegistry(configurationGeneration.from(5), entries);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.entries).toHaveLength(600);
    const bounded = queryCapabilityRegistry(created.value);
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) return;
    expect(bounded.value.entries).toHaveLength(32);
    expect(
      queryCapabilityRegistry(created.value, { limit: MAX_CAPABILITY_QUERY_LIMIT + 1 }),
    ).toEqual({
      ok: false,
      error: { code: "invalid-query-limit", maximum: MAX_CAPABILITY_QUERY_LIMIT },
    });
    expect(queryCapabilityRegistry(created.value, { offset: -1 })).toEqual({
      ok: false,
      error: { code: "invalid-query-offset" },
    });
  });

  test("fails closed on namespace collisions and unknown manifest fields", () => {
    const first = entry("same");
    const second = entry("same", { source: "plugin" });
    const collision = createCapabilityRegistry(configurationGeneration.from(1), [first, second]);

    expect(collision).toEqual({
      ok: false,
      error: { code: "namespace-collision", registryKey: "tool:workspace/same" },
    });
    const malformed = parseCapabilityRegistryDocument({
      ...document("unsafe"),
      credential: "must-not-enter-the-catalog",
    });
    expect(malformed.ok).toBe(false);
  });

  test("keeps lifecycle and orthogonal operational state distinct", () => {
    const unavailable = entry("optional", {
      state: {
        availability: "unavailable",
        availabilityReason: "missing executable",
        health: "unavailable",
        healthReason: "probe failed",
        executable: false,
        executionReason: "runner absent",
        operational: defaultCapabilityOperationalState({
          configured: false,
          allowed: false,
          deferred: true,
          omitted: true,
        }),
      },
    });

    expect(capabilityLifecycle(unavailable)).toEqual({
      registered: true,
      available: false,
      disclosed: false,
      executable: false,
      projected: false,
      availability: "unavailable",
      health: "unavailable",
      reasons: ["missing executable", "probe failed", "runner absent"],
    });
    expect(unavailable.state.operational.deferred).toBe(true);
    expect(unavailable.state.operational.omitted).toBe(true);
  });

  test("binds queries to immutable generations and leaves in-flight generations stable", () => {
    const oldRegistry = createCapabilityRegistry(configurationGeneration.from(7), [entry("old")]);
    const newRegistry = createCapabilityRegistry(configurationGeneration.from(8), [entry("new")]);
    expect(oldRegistry.ok && newRegistry.ok).toBe(true);
    if (!oldRegistry.ok || !newRegistry.ok) return;

    expect(
      queryCapabilityRegistry(newRegistry.value, {
        generation: oldRegistry.value.generation,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "stale-generation",
        expected: configurationGeneration.from(7),
        actual: configurationGeneration.from(8),
      },
    });
    expect(oldRegistry.value.resolveByKey("tool:workspace/old")?.name).toBe("old");
    expect(oldRegistry.value.resolveByKey("tool:workspace/new")).toBeNull();
  });

  test("serializes deterministically without schemas or implementation bodies", () => {
    const generation = configurationGeneration.from(9);
    const one = createCapabilityRegistry(generation, [entry("zeta"), entry("alpha")]);
    const two = createCapabilityRegistry(generation, [entry("alpha"), entry("zeta")]);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    const first = serializeCapabilityRegistry(one.value);
    const second = serializeCapabilityRegistry(two.value);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).not.toContain("inputDigest");
    expect(first.value).not.toContain("outputDigest");
    expect(first.value).not.toContain("credential");
  });
});
