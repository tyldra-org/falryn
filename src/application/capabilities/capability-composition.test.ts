import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type CompositionGraph,
  parseCompositionGraph,
} from "../../domain/capabilities/composition.ts";
import {
  configurationGeneration,
  createManualClock,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { parseWireEvent, toWireEvent } from "../../domain/sessions/wire.ts";
import {
  createToolHookRegistry,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolInvocationOutcome,
} from "../../domain/tools/index.ts";
import { createCapabilityTrust } from "../extensions/capability-trust.ts";
import { inspectPackageTrust } from "../extensions/package-trust.ts";
import { memoryTrustStore, trustFixture } from "../extensions/trust-fixtures.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { createProductToolGateway } from "../tools/product-tool-gateway.ts";
import { createCapabilityComposition } from "./capability-composition.ts";
import { createProductCapabilityRegistry } from "./product-capability-registry.ts";

const trustTemplate = await trustFixture();

function fixture(
  run: (request: ToolRunnerRequest) => Promise<ToolInvocationOutcome> = async (request) => ({
    status: "completed",
    effect: "completed",
    output: { text: request.input.text },
  }),
  effectFor?: (input: Readonly<Record<string, unknown>>) => "observation" | "mutation",
) {
  const generation = configurationGeneration.from(3);
  const clock = createManualClock(instant(100));
  const trustStore = memoryTrustStore();
  const observation = {
    ...trustTemplate.observation,
    now: 100,
    evidence: { ...trustTemplate.observation.evidence, observedAt: 100 },
  };
  const approval = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(trustStore, observation, [], approval);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error("trust fixture preview");
  inspectPackageTrust(trustStore, observation, [], {
    ...approval,
    confirmation: preview.confirmation,
  });
  const trust = createCapabilityTrust(trustStore, () => ({
    ...observation,
    now: Number(clock.now()),
  }));
  const resources = createProductResources(clock);
  const taskResources = resources.openTask(String(generation));
  const correlation = {
    configurationGeneration: generation,
    workspaceId: workspaceId.from("workspace-composition"),
    sessionId: sessionId.from("session-composition"),
    traceId: traceId.from("trace-composition"),
  };
  const entries = (["builtin", "mcp", "plugin", "integration"] as const).map((source, index) => {
    const entry = createToolRegistryEntry(
      {
        namespace: `owner${index}`,
        name: `echo${index}`,
        version: 1,
        source,
        title: "Echo",
        description: "Fixture echo",
        effect: "observation",
        capabilityKind: "other",
        platforms: [],
        limits: defaultToolLimits(),
        concurrency: defaultConcurrencyContract(),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: z.strictObject({ text: z.string() }),
        outputSchema: z.strictObject({ text: z.string() }),
        ...(effectFor ? { effectFor } : {}),
      },
    );
    if (!entry.ok) throw new Error(entry.error.code);
    return entry.value;
  });
  const built = createToolRegistry(generation, entries);
  if (!built.ok) throw new Error(built.error.code);
  const registry = built.value;
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw new Error(hooks.error.code);
  const journal = createTurnEventJournal({
    clock,
    eventStore: createInMemoryEventStore(),
    streamId: streamId.from("composition-stream"),
    correlation,
  });
  const calls: ToolRunnerRequest[] = [];
  const enabled = new Set(entries.map((entry) => entry.manifest.capabilityId));
  const nativeRunner = {
    hasBinding: (id: ToolRunnerRequest["capabilityId"]) => enabled.has(id),
    async execute(request: ToolRunnerRequest) {
      calls.push(request);
      return run(request);
    },
  };
  const disclosedToolNames = new Set(entries.map((entry) => entry.manifest.name));
  const options = {
    registry,
    nativeRunner,
    taskResources,
    journal,
    clock,
    correlation,
    turnId: turnId.from("turn-composition"),
    disclosedToolNames,
  };
  const gateway = createProductToolGateway({
    trust,
    ...options,
    runner: nativeRunner,
    hooks: hooks.value,
    effectLedger: new Map(),
  });
  const compose = () => createCapabilityComposition({ ...options, gateway });
  const graph = (): CompositionGraph => ({
    version: 1,
    id: "graph",
    generation,
    maxConcurrent: 4,
    timeoutMs: 1000,
    nodes: entries.map((entry, index) => ({
      id: `n${index}`,
      capabilityId: entry.manifest.capabilityId,
      capabilityVersion: 1,
      effect: "observation",
      input: { text: `text${index}` },
      dependencies: [],
      transfers: [],
    })),
  });
  return {
    compose,
    graph,
    calls,
    enabled,
    entries,
    journal,
    registry,
    nativeRunner,
    taskResources,
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}
const signal = () => new AbortController().signal;

describe("capability composition", () => {
  test("a graph cannot label an input-dependent mutation as observation", async () => {
    const f = fixture(undefined, () => "mutation");
    const result = await f.compose().execute(f.graph(), signal());
    expect(result.status).not.toBe("completed");
    expect(f.calls).toHaveLength(0);
    f.taskResources.close();
  });
  test("all native origins share typed transfers, admission, durable provenance and effect-free replay", async () => {
    const f = fixture();
    const graph = f.graph();
    graph.nodes[1] = {
      ...required(graph.nodes[1]),
      input: {},
      dependencies: ["n0"],
      transfers: [{ from: "n0", path: ["text"], target: "text" }],
    };
    const result = await f.compose().execute(graph, signal());
    expect(
      result.records.map((record) =>
        record.outcome.status === "completed" ? "completed" : record.outcome,
      ),
    ).toEqual(["completed", "completed", "completed", "completed"]);
    expect(result.status).toBe("completed");
    expect(f.calls.find((call) => call.toolName === "echo1")?.input.text).toBe("text0");
    expect(f.calls.every((call) => call.captureExactOutput === undefined)).toBe(true);
    expect(result.records.every((record) => record.outcome.admission?.acquired)).toBe(true);
    const replay = await f.journal.replay();
    expect("events" in replay).toBe(true);
    if (!("events" in replay)) throw new Error("missing events");
    for (const event of replay.events) expect(parseWireEvent(toWireEvent(event)).ok).toBe(true);
    const graphEnd = replay.events.find(
      (event) =>
        event.kind === "capability.invocation.completed" &&
        event.capabilityId === "falryn:composition:v1",
    );
    expect(graphEnd?.payload).toMatchObject({
      composition: {
        topology: expect.arrayContaining([
          { nodeId: expect.any(String), dependencies: [], status: "completed" },
        ]),
      },
    });
    expect(JSON.stringify(graphEnd)).not.toContain("text0");
    const retried = await f.compose().execute(graph, signal());
    expect(retried.reason).toBe("composition-journal-or-replay");
    expect(f.calls).toHaveLength(4);
  });

  test("whole-graph validation rejects cycles, unknown edges and forged identity before any effect", async () => {
    for (const defect of ["cycle", "unknown", "identity", "effect", "input"] as const) {
      const f = fixture();
      const graph = f.graph();
      if (defect === "cycle") required(graph.nodes[0]).dependencies = ["n0"];
      if (defect === "unknown") required(graph.nodes[0]).dependencies = ["missing"];
      if (defect === "identity") required(graph.nodes[0]).capabilityVersion = 2;
      if (defect === "effect") required(graph.nodes[0]).effect = "external";
      if (defect === "input") required(graph.nodes[0]).input = { text: 3 };
      const result = await f.compose().execute(graph, signal());
      expect(result.status).not.toBe("completed");
      expect(f.calls).toHaveLength(0);
    }
  });

  test("descriptor publication alone is not an executable binding", async () => {
    const f = fixture();
    expect(
      createProductCapabilityRegistry(f.registry.generation, f.registry).entries.every(
        (entry) => !entry.state.executable,
      ),
    ).toBe(true);
    f.enabled.clear();
    expect((await f.compose().execute(f.graph(), signal())).reason).toBe("missing-native-binding");
    expect(f.calls).toHaveLength(0);
  });

  test("a revoked node cannot run after its predecessor settles", async () => {
    const f = fixture(async (request) => {
      if (request.toolName === "echo0")
        f.enabled.delete(required(f.entries[1]).manifest.capabilityId);
      return { status: "completed", effect: "completed", output: { text: "done" } };
    });
    const graph = f.graph();
    required(graph.nodes[1]).dependencies = ["n0"];
    const result = await f.compose().execute(graph, signal());
    expect(result.records[1]?.outcome).toMatchObject({
      status: "unavailable",
      reason: "missing-native-binding",
    });
    expect(f.calls.some((call) => call.toolName === "echo1")).toBe(false);
  });

  test("partial, malformed and uncertain predecessors never feed dependents", async () => {
    for (const status of ["partial", "malformed", "uncertain"] as const) {
      const f = fixture(async (request) =>
        request.toolName === "echo0"
          ? status === "partial"
            ? { status, effect: "completed", output: { text: "partial" } }
            : status === "malformed"
              ? { status: "completed", effect: "completed", output: { text: 4 } }
              : { status, effect: "uncertain", recoveryHint: "fixture" }
          : { status: "completed", effect: "completed", output: { text: "other" } },
      );
      const graph = f.graph();
      required(graph.nodes[1]).dependencies = ["n0"];
      const result = await f.compose().execute(graph, signal());
      expect(result.status).not.toBe("completed");
      expect(f.calls.some((call) => call.toolName === "echo1")).toBe(false);
      expect(result.records[1]?.outcome).toMatchObject({
        status: "unavailable",
        reason: "composition-dependency-incomplete",
      });
    }
  });

  test("transfers refuse missing, oversized and incorrectly typed exact values", async () => {
    for (const text of ["a".repeat(70 * 1024), "normal"]) {
      const f = fixture(async () => ({
        status: "completed",
        effect: "completed",
        output: { text },
      }));
      const graph = f.graph();
      graph.nodes[1] = {
        ...required(graph.nodes[1]),
        input: {},
        dependencies: ["n0"],
        transfers: [
          { from: "n0", path: text === "normal" ? ["missing"] : ["text"], target: "text" },
        ],
      };
      const result = await f.compose().execute(graph, signal());
      expect(result.records[1]?.outcome.status).toBe("unavailable");
      expect(f.calls.some((call) => call.toolName === "echo1")).toBe(false);
    }
  });

  test("parent limits apply across graph nodes without a new allowance", async () => {
    const f = fixture();
    f.taskResources.tighten({ operations: 1 });
    const result = await f.compose().execute(f.graph(), signal());
    expect(result.status).not.toBe("completed");
    expect(f.calls).toHaveLength(1);
    expect(f.taskResources.remaining("operations")).toBe(0);
  });

  test("durable settlement retains partial effects and post-effect schema failures", async () => {
    for (const malformed of [false, true]) {
      const f = fixture(async () =>
        malformed
          ? { status: "completed", effect: "completed", output: { text: 42 } }
          : { status: "partial", effect: "partial", output: { text: "partial" } },
      );
      const result = await f.compose().execute(f.graph(), signal());
      expect(result.status).toBe("partial");
      const replay = await f.journal.replay();
      if (!("events" in replay)) throw new Error("missing settlement");
      const graphEnd = replay.events.find(
        (event) =>
          event.kind === "capability.invocation.completed" &&
          event.capabilityId === "falryn:composition:v1",
      );
      expect(graphEnd?.payload).toMatchObject({
        outcome: { kind: "failed", effect: malformed ? "completed" : "partial" },
      });
      if (malformed)
        expect(
          result.records.every(
            (record) => record.outcome.status === "failed" && record.outcome.effect === "completed",
          ),
        ).toBe(true);
    }
  });

  test("stale generation and pre-cancelled requests admit no effects", async () => {
    const f = fixture();
    const graph = f.graph();
    graph.generation += 1;
    expect((await f.compose().execute(graph, signal())).reason).toBe(
      "stale-composition-generation",
    );
    const controller = new AbortController();
    controller.abort();
    expect((await f.compose().execute(f.graph(), controller.signal)).status).not.toBe("completed");
    expect(f.calls).toHaveLength(0);
  });

  test("transferred objects cannot satisfy a string input schema", async () => {
    const f = fixture();
    const graph = f.graph();
    required(graph.nodes[1]).dependencies = ["n0"];
    required(graph.nodes[1]).transfers = [{ from: "n0", path: [], target: "text" }];
    const result = await f.compose().execute(graph, signal());
    expect(result.records[1]?.outcome.status).toBe("malformed");
    expect(f.calls.some((call) => call.toolName === "echo1")).toBe(false);
  });

  test("cancellation without termination proof stays uncertain and blocks pending admission", async () => {
    const controller = new AbortController();
    let settled = false;
    const f = fixture(async () => {
      controller.abort();
      await Promise.resolve();
      settled = true;
      return { status: "cancelled", effect: "none" };
    });
    const graph = f.graph();
    graph.maxConcurrent = 1;
    const result = await f.compose().execute(graph, controller.signal);
    expect(result.status).toBe("uncertain");
    expect(result.records.slice(1).every((record) => record.outcome.status === "cancelled")).toBe(
      true,
    );
    expect(settled).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  test("graph caps reject oversized topology and attempted authority fields", () => {
    const f = fixture();
    const graph = f.graph();
    const node = required(graph.nodes[0]);
    for (const value of [
      { ...graph, nodes: Array.from({ length: 65 }, (_, i) => ({ ...node, id: String(i) })) },
      { ...graph, maxConcurrent: 17 },
      { ...graph, timeoutMs: 30 * 60 * 1000 + 1 },
      { ...graph, authority: "full-user" },
      { ...graph, nodes: [{ ...node, execute: "shell" }] },
      { ...graph, nodes: [node, node] },
    ])
      expect(parseCompositionGraph(value).ok).toBe(false);
  });

  test("concurrent duplicate graph requests and reconstructed owners cannot repeat effects", async () => {
    const f = fixture();
    const owner = f.compose();
    const results = await Promise.all([
      owner.execute(f.graph(), signal()),
      owner.execute(f.graph(), signal()),
    ]);
    expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(f.calls).toHaveLength(4);
    expect((await f.compose().execute(f.graph(), signal())).status).toBe("unavailable");
    expect(f.calls).toHaveLength(4);
  });

  test("deadline cancellation prevents dependent launch and preserves uncertainty", async () => {
    const f = fixture(async (request) => {
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { status: "cancelled", effect: "uncertain" };
    });
    const graph = f.graph();
    graph.timeoutMs = 10;
    graph.maxConcurrent = 1;
    required(graph.nodes[1]).dependencies = ["n0"];
    const result = await f.compose().execute(graph, signal());
    expect(result.status).not.toBe("completed");
    expect(f.calls).toHaveLength(1);
  });

  test("thrown native errors remain uncertain and do not release their permit", async () => {
    const f = fixture(async () => {
      throw new Error("private fixture data");
    });
    const graph = f.graph();
    graph.nodes = graph.nodes.slice(0, 1);
    const result = await f.compose().execute(graph, signal());
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("private fixture data");
  });

  test("rejects oversized, cyclic, deep, accessor and prototype-sensitive JSON", () => {
    const f = fixture();
    const graph = f.graph();
    required(graph.nodes[0]).input = { text: "a".repeat(256 * 1024) };
    expect(parseCompositionGraph(graph).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseCompositionGraph(cyclic).ok).toBe(false);
    expect(
      parseCompositionGraph({
        get bad() {
          throw new Error("must not read");
        },
      }).ok,
    ).toBe(false);
    const bad = f.graph();
    required(bad.nodes[1]).transfers = [{ from: "n0", path: ["__proto__"], target: "text" }];
    expect(parseCompositionGraph(bad).ok).toBe(false);
  });
});
