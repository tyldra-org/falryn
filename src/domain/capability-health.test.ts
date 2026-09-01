import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  configurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  inspectCapabilityHealth,
  instant,
  MAX_CAPABILITY_HEALTH_QUERY_LIMIT,
  queryCapabilityHealth,
} from "./index.ts";

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
    routing: { costClass: "low", latencyClass: "instant" },
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
}

function registry(...documents: readonly CapabilityRegistryDocument[]) {
  const entries = documents.map((value) => {
    const created = createCapabilityRegistryEntry(value);
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  });
  const created = createCapabilityRegistry(configurationGeneration.from(12), entries);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe("capability health", () => {
  test("keeps registration, selection, disclosure, and effective health distinct", () => {
    const capabilities = registry(document("read_file"), document("run_shell", { family: "run" }));
    const read = capabilities.entries.find((entry) => entry.name === "read_file");
    if (read === undefined) throw new Error("missing fixture");

    const snapshot = inspectCapabilityHealth(capabilities, "native-model", {
      now: instant(1_000),
      disclosed: [read.capabilityId],
      selected: [read.capabilityId],
      runtime: { attemptRunner: "available", provider: "available", workspace: "available" },
    });

    expect(snapshot.summary).toMatchObject({
      registered: 2,
      available: 2,
      disclosed: 1,
      selected: 1,
      selectable: 2,
    });
    expect(
      snapshot.entries.find((entry) => entry.capabilityId === read.capabilityId),
    ).toMatchObject({
      registered: true,
      available: true,
      disclosed: true,
      executable: true,
      selected: true,
      health: "healthy",
    });
  });

  test("explains platform, dependency, credential, policy, and probe failures without secrets", () => {
    const capabilities = registry(
      document("remote_search", {
        family: "search",
        effect: "external",
        compatibility: { os: ["linux"], arch: ["x64"], dependencies: ["remote-cli"] },
      }),
    );
    const target = capabilities.entries[0];
    if (target === undefined) throw new Error("missing fixture");
    const snapshot = inspectCapabilityHealth(capabilities, "native-model", {
      now: instant(10_000),
      os: "darwin",
      arch: "arm64",
      dependencies: { "remote-cli": "unavailable" },
      credentials: { [target.capabilityId]: "expired" },
      deniedEffects: ["external"],
      probes: {
        [target.capabilityId]: {
          state: "degraded",
          code: "probe-degraded",
          message: "endpoint slow token=[redacted]",
          observedAt: instant(9_000),
          expiresAt: instant(11_000),
          recovery: null,
        },
      },
      runtime: { attemptRunner: "available", provider: "available", workspace: "available" },
    });
    const entry = snapshot.entries[0];
    expect(entry?.health).toBe("denied");
    expect(entry?.selectable).toBe(false);
    expect(entry?.diagnostics.map((item) => item.code)).toEqual([
      "platform-incompatible",
      "architecture-incompatible",
      "missing-dependency",
      "policy-denied",
      "credential-expired",
      "probe-degraded",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("api-key");
  });

  test("treats stale probes as unknown and names missing model runtime facts", () => {
    const capabilities = registry(document("read_file"));
    const target = capabilities.entries[0];
    if (target === undefined) throw new Error("missing fixture");
    const snapshot = inspectCapabilityHealth(capabilities, "headless", {
      now: instant(20_000),
      probes: {
        [target.capabilityId]: {
          state: "healthy",
          code: "probe-unknown",
          message: "healthy",
          observedAt: instant(1_000),
          expiresAt: instant(2_000),
          recovery: null,
        },
      },
      runtime: { attemptRunner: "missing", provider: "missing", workspace: "missing" },
    });
    expect(snapshot.entries[0]?.diagnostics.map((item) => item.code)).toEqual([
      "probe-stale",
      "missing-attempt-runner",
      "missing-provider",
      "missing-workspace",
    ]);
    expect(snapshot.entries[0]?.health).toBe("unavailable");
  });

  test("does not equate Falryn registration with external-host visibility", () => {
    const snapshot = inspectCapabilityHealth(registry(document("read_file")), "external-host", {
      externalHost: { installation: "missing", connection: "disconnected", schema: "rejected" },
    });
    expect(snapshot.entries[0]).toMatchObject({
      registered: true,
      available: false,
      disclosed: false,
      projected: false,
      health: "incompatible",
    });
    expect(snapshot.entries[0]?.diagnostics.map((item) => item.code)).toEqual([
      "host-not-installed",
      "host-disconnected",
      "host-schema-rejected",
    ]);
  });

  test("filters and paginates one immutable generation with deterministic handles", () => {
    const capabilities = registry(
      document("read_file"),
      document("run_shell", { family: "run", effect: "external" }),
    );
    const snapshot = inspectCapabilityHealth(capabilities, "cli");
    const page = queryCapabilityHealth(snapshot, { families: ["read"], limit: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(1);
    expect(page.value.entries[0]?.family).toBe("read");
    expect(page.value.nextHandle).toBeNull();
    expect(
      queryCapabilityHealth(snapshot, {
        generation: configurationGeneration.from(11),
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "stale-generation",
        expected: configurationGeneration.from(11),
        actual: configurationGeneration.from(12),
      },
    });
    expect(
      queryCapabilityHealth(snapshot, { limit: MAX_CAPABILITY_HEALTH_QUERY_LIMIT + 1 }),
    ).toEqual({
      ok: false,
      error: { code: "invalid-query-limit", maximum: MAX_CAPABILITY_HEALTH_QUERY_LIMIT },
    });
  });
});
