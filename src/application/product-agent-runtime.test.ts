import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createInMemoryEventStore,
  createManualClock,
  createToolCatalog,
  createToolRegistry,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createDeterministicProviderAdapter } from "../providers/index.ts";
import {
  composeProductAgentRuntime,
  type ProductAgentRuntimePorts,
} from "./product-agent-runtime.ts";
import type { ToolRunnerPort } from "./tool-call-loop.ts";
import type { AttemptRunnerPort } from "./turn-attempt-policy.ts";

const correlation = {
  workspaceId: workspaceId.from("workspace-product-1"),
  sessionId: sessionId.from("session-product-1"),
  traceId: traceId.from("trace-product-1"),
  configurationGeneration: configurationGeneration.from(0),
};

function ports(overrides: Partial<ProductAgentRuntimePorts> = {}): ProductAgentRuntimePorts {
  return {
    eventStore: createInMemoryEventStore(),
    clock: createManualClock(instant(1_000)),
    streamId: streamId.from("session:product-1"),
    correlation,
    ...overrides,
  };
}

describe("composeProductAgentRuntime", () => {
  test("fails closed when required ports are missing", () => {
    const base = ports();
    expect(
      composeProductAgentRuntime({
        ...base,
        eventStore: null as unknown as ProductAgentRuntimePorts["eventStore"],
      }).ok,
    ).toBe(false);
    expect(
      composeProductAgentRuntime({
        ...base,
        clock: null as unknown as ProductAgentRuntimePorts["clock"],
      }).ok,
    ).toBe(false);
    expect(
      composeProductAgentRuntime({
        ...base,
        streamId: null as unknown as ProductAgentRuntimePorts["streamId"],
      }).ok,
    ).toBe(false);
    expect(
      composeProductAgentRuntime({
        ...base,
        correlation: null as unknown as ProductAgentRuntimePorts["correlation"],
      }).ok,
    ).toBe(false);
  });

  test("composes coordinator, journal, empty tools, and null attachment seams", () => {
    const composed = composeProductAgentRuntime(ports());
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }
    const runtime = composed.value;
    expect(runtime.toolCatalog.resolve("read_file")).toBeNull();
    expect(runtime.toolRunner).toBeNull();
    expect(runtime.providerAdapter).toBeNull();
    expect(runtime.attemptRunner).toBeNull();
    expect(runtime.attachments.turnProducer).not.toBeNull();
    expect(runtime.attachments.submission).toBeNull();
    expect(runtime.attachments.turnProducer.streamId).toBe(streamId.from("session:product-1"));
    expect(runtime.requireToolRunner()).toEqual({
      ok: false,
      error: { code: "tool-runner-required" },
    });
    expect(runtime.requireProviderAdapter()).toEqual({
      ok: false,
      error: { code: "provider-adapter-required" },
    });
    expect(runtime.requireAttemptRunner()).toEqual({
      ok: false,
      error: { code: "attempt-runner-required" },
    });
    expect(runtime.inspectCapabilities("cli")).toEqual({
      ok: false,
      error: { code: "capability-registry-required" },
    });
  });

  test("hosts a turn through coordinator and durable journal without builtins or HTTP", async () => {
    const composed = composeProductAgentRuntime(ports());
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }

    const hosted = await composed.value.hostTurn({
      turnId: turnId.from("turn-product-1"),
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
    });
    expect(hosted.kind).toBe("hosted");
    if (hosted.kind !== "hosted") {
      return;
    }
    expect(hosted.persist.kind).toBe("persisted");
    expect(composed.value.turnCoordinator.get(turnId.from("turn-product-1"))).not.toBeNull();

    const replay = await composed.value.journal.replay();
    expect(replay.kind === "rebuilt" || replay.kind === "partial").toBe(true);
    if (replay.kind === "rebuilt" || replay.kind === "partial") {
      expect(replay.events.some((event) => event.kind === "turn.started")).toBe(true);
    }
  });

  test("accepts optional provider, tool, and attempt seams without registering builtins", () => {
    const denyRunner: ToolRunnerPort = {
      execute: async () => ({
        status: "denied",
        reason: "no product tools registered yet",
        effect: "none",
      }),
    };
    const attemptRunner: AttemptRunnerPort = {
      run: async () => {
        throw new Error("attempt runner must not run in composition-only test");
      },
    };
    const composed = composeProductAgentRuntime(
      ports({
        toolCatalog: createToolCatalog(correlation.configurationGeneration, []),
        toolRunner: denyRunner,
        providerAdapter: createDeterministicProviderAdapter({
          script: { kind: "text", text: "ok" },
        }),
        attemptRunner,
      }),
    );
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }
    expect(composed.value.requireToolRunner().ok).toBe(true);
    expect(composed.value.requireProviderAdapter().ok).toBe(true);
    expect(composed.value.requireAttemptRunner().ok).toBe(true);
    expect(composed.value.toolCatalog.resolve("shell")).toBeNull();
  });

  test("exposes one read-only health and inspector boundary for every consumer", () => {
    const registry = createToolRegistry(correlation.configurationGeneration, []);
    if (!registry.ok) throw new Error(registry.error.code);
    const composed = composeProductAgentRuntime(ports({ toolRegistry: registry.value }));
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;

    const health = composed.value.inspectCapabilities("opentui");
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value).toMatchObject({
      consumer: "opentui",
      observedAt: instant(1_000),
      summary: { registered: 0 },
    });
    const inspector = composed.value.capabilityInspector("cli");
    expect(inspector.ok).toBe(true);
    if (!inspector.ok) return;
    expect(inspector.value.doctor()).toMatchObject({ healthy: true, readOnly: true });
    expect(inspector.value.permissions().mutationAction).toBe("settings.permissions");
  });
});
