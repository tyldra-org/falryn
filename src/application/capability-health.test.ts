import { describe, expect, test } from "bun:test";

import {
  type CapabilityRegistryDocument,
  configurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  createManualClock,
  defaultCapabilityOperationalState,
  instant,
} from "../domain/index.ts";
import {
  inspectProductCapabilityHealth,
  MAX_CAPABILITY_PROBE_CONCURRENCY,
  MAX_CAPABILITY_PROBES,
} from "./capability-health.ts";
import { createDiagnosticsCollector } from "./diagnostics-collector.ts";

function registry() {
  const document: CapabilityRegistryDocument = {
    namespace: "workspace",
    name: "read_file",
    version: 1,
    source: "builtin",
    kind: "tool",
    title: "Read file",
    summary: "Read a file",
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
  };
  const entry = createCapabilityRegistryEntry(document);
  if (!entry.ok) throw new Error(entry.error.code);
  const created = createCapabilityRegistry(configurationGeneration.from(4), [entry.value]);
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe("product capability health", () => {
  test("runs a bounded probe and emits one redacted diagnostic projection", async () => {
    const capabilities = registry();
    const target = capabilities.entries[0];
    if (target === undefined) throw new Error("missing fixture");
    const clock = createManualClock(instant(1_000));
    const diagnostics = createDiagnosticsCollector({ clock });
    const outcome = await inspectProductCapabilityHealth({
      registry: capabilities,
      consumer: "cli",
      clock,
      diagnostics,
      probes: [
        {
          capabilityId: target.capabilityId,
          async run() {
            return {
              state: "degraded",
              message: "credential sk-live-secret was rejected",
              ttlMs: 1_000,
              recovery: { kind: "authenticate", handle: "provider:login:test" },
            };
          },
        },
      ],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.entries[0]).toMatchObject({ health: "degraded", selectable: true });
    expect(outcome.value.entries[0]?.diagnostics[0]).toMatchObject({
      code: "probe-degraded",
      recovery: { kind: "authenticate", handle: "provider:login:test" },
    });
    expect(JSON.stringify(outcome.value)).not.toContain("sk-live-secret");
    expect(diagnostics.events()).toHaveLength(1);
    expect(JSON.stringify(diagnostics.events())).not.toContain("sk-live-secret");
  });

  test("turns a deadline into an explicit unavailable probe observation", async () => {
    const capabilities = registry();
    const target = capabilities.entries[0];
    if (target === undefined) throw new Error("missing fixture");
    const clock = createManualClock(instant(5_000));
    const pending = inspectProductCapabilityHealth({
      registry: capabilities,
      consumer: "cli",
      clock,
      timeoutMs: 10,
      probes: [
        {
          capabilityId: target.capabilityId,
          run: () => new Promise(() => undefined),
        },
      ],
    });
    await clock.runUntilIdle();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.entries[0]?.diagnostics[0]).toMatchObject({
      code: "probe-timed-out",
      state: "unknown",
    });
  });

  test("fails closed on cancellation and invalid probe plans", async () => {
    const capabilities = registry();
    const target = capabilities.entries[0];
    if (target === undefined) throw new Error("missing fixture");
    const clock = createManualClock();
    const controller = new AbortController();
    controller.abort();
    expect(
      await inspectProductCapabilityHealth({
        registry: capabilities,
        consumer: "cli",
        clock,
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, error: { code: "cancelled" } });
    expect(
      await inspectProductCapabilityHealth({
        registry: capabilities,
        consumer: "cli",
        clock,
        concurrency: MAX_CAPABILITY_PROBE_CONCURRENCY + 1,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "invalid-concurrency",
        maximum: MAX_CAPABILITY_PROBE_CONCURRENCY,
      },
    });
    expect(
      await inspectProductCapabilityHealth({
        registry: capabilities,
        consumer: "cli",
        clock,
        probes: Array.from({ length: MAX_CAPABILITY_PROBES + 1 }, () => ({
          capabilityId: target.capabilityId,
          async run() {
            return { state: "healthy" as const };
          },
        })),
      }),
    ).toEqual({
      ok: false,
      error: { code: "too-many-probes", maximum: MAX_CAPABILITY_PROBES },
    });
  });
});
