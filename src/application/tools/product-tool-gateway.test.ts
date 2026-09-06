import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { artifactId } from "../../domain/artifacts/index.ts";
import {
  configurationGeneration,
  createManualClock,
  instant,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import {
  createToolHookRegistry,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { createProductToolGateway } from "./product-tool-gateway.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

const generation = configurationGeneration.from(3);
const turn = turnId.from("turn-gateway-1");
const correlation = {
  workspaceId: workspaceId.from("workspace-gateway-1"),
  sessionId: sessionId.from("session-gateway-1"),
  traceId: traceId.from("trace-gateway-1"),
  configurationGeneration: generation,
};

function setup() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work": { kind: "directory" },
      "/work/a.ts": { kind: "file", text: "export const a = 1;\n" },
    },
  });
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem,
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const eventStore = createInMemoryEventStore();
  const clock = createManualClock(instant(100));
  const journal = createTurnEventJournal({
    eventStore,
    clock,
    streamId: streamId.from("session:gateway-1"),
    correlation,
  });
  return { fileSystem, tools, eventStore, clock, journal };
}

describe("createProductToolGateway", () => {
  test("runs observations through hooks, scheduling, projection, and durable facts", async () => {
    const { tools, clock, journal } = setup();
    const hookPoints: string[] = [];
    const hooks = createToolHookRegistry(generation, [
      {
        id: "gateway.pre",
        point: "before-capability-invocation",
        priority: 1,
        run: (envelope) => {
          hookPoints.push(envelope.point);
          return { kind: "allow" };
        },
      },
      {
        id: "gateway.post",
        point: "after-capability-invocation",
        priority: 1,
        run: (envelope) => {
          hookPoints.push(envelope.point);
          return { kind: "allow" };
        },
      },
    ]);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    const entry = tools.registry.resolveByName("read_file");
    if (entry === null) {
      throw new Error("read_file is not registered");
    }
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        async execute(request) {
          const outcome = await tools.runner.execute(request);
          return outcome.status === "completed"
            ? {
                ...outcome,
                result: {
                  artifacts: [
                    {
                      artifactId: artifactId.from("capture-result"),
                      required: true,
                      committed: true,
                      truncated: false,
                    },
                  ],
                  captureOverflow: false,
                  containedProcessExitCode: 0,
                },
              }
            : outcome;
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["read_file"]),
      effectLedger: new Map(),
    });

    const outcome = await gateway.execute({
      invocationId: invocationId.from("inv-gateway-read"),
      toolCallId: "call-read",
      toolName: "read_file",
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input: { path: "a.ts" },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe("completed");
    expect(JSON.stringify(outcome)).toContain("export const a");
    if (outcome.status === "completed") {
      expect(outcome.output).toMatchObject({
        artifacts: [{ artifactId: "capture-result", committed: true }],
      });
    }
    expect(hookPoints).toEqual(["before-capability-invocation", "after-capability-invocation"]);
    const replay = await journal.replay();
    expect(replay.kind === "rebuilt" || replay.kind === "partial").toBe(true);
    if (replay.kind === "rebuilt" || replay.kind === "partial") {
      expect(replay.events.map((event) => event.kind)).toEqual([
        "capability.invocation.started",
        "capability.invocation.completed",
      ]);
      const started = replay.events[0];
      expect(started?.kind === "capability.invocation.started" ? started.payload : null).toEqual({
        capabilityVersion: entry.manifest.version,
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });

  test("rejects undisclosed tools before the executor runs", async () => {
    const { tools, clock, journal } = setup();
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    let runnerCalls = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        execute: async (request) => {
          runnerCalls += 1;
          return tools.runner.execute(request);
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(),
      effectLedger: new Map(),
    });
    const entry = tools.registry.resolveByName("read_file");
    if (entry === null) {
      throw new Error("read_file is not registered");
    }

    const outcome = await gateway.execute({
      invocationId: invocationId.from("inv-gateway-hidden"),
      toolCallId: "call-hidden",
      toolName: "read_file",
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input: { path: "a.ts" },
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "tool-not-disclosed",
      effect: "none",
    });
    expect(runnerCalls).toBe(0);
  });

  test("binds confirmation and prevents duplicate consequential effects", async () => {
    const { tools, clock, journal } = setup();
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) {
      throw new Error(hooks.error.code);
    }
    let runnerCalls = 0;
    let confirmations = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: tools.registry,
      runner: {
        execute: async (request) => {
          runnerCalls += 1;
          return tools.runner.execute(request);
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["write_files"]),
      confirmation: {
        resolve: async (request) => {
          confirmations += 1;
          return { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
      effectLedger: new Map(),
    });
    const entry = tools.registry.resolveByName("write_files");
    if (entry === null) {
      throw new Error("write_files is not registered");
    }
    const input = {
      targets: [{ path: "created.ts", kind: "create", text: "export {};\n" }],
    };
    const execute = (id: string) =>
      gateway.execute({
        invocationId: invocationId.from(id),
        toolCallId: id,
        toolName: "write_files",
        capabilityId: entry.manifest.capabilityId,
        version: entry.manifest.version,
        effect: entry.manifest.effect,
        input,
        signal: new AbortController().signal,
      });

    expect((await execute("inv-write-1")).status).toBe("completed");
    expect((await execute("inv-write-2")).status).toBe("completed");
    expect(confirmations).toBe(1);
    expect(runnerCalls).toBe(1);
  });

  test("uses the validated argument-derived effect throughout the gateway", async () => {
    const { clock, journal } = setup();
    const entry = createToolRegistryEntry(
      {
        namespace: "workspace",
        name: "debug_evaluate",
        version: 1,
        source: "builtin",
        title: "Evaluate expression",
        description: "Evaluate with an effect selected from the validated context",
        effect: "interactive",
        capabilityKind: "dap",
        platforms: [],
        limits: defaultToolLimits(),
        concurrency: defaultConcurrencyContract(),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: z
          .object({ context: z.enum(["watch", "repl"]), expression: z.string().min(1) })
          .strict(),
        outputSchema: z.object({ result: z.string() }).strict(),
        effectFor: (input) => (input.context === "repl" ? "interactive" : "observation"),
      },
    );
    if (!entry.ok) throw new Error(entry.error.code);
    const registry = createToolRegistry(generation, [entry.value]);
    if (!registry.ok) throw new Error(registry.error.code);
    const hooks = createToolHookRegistry(generation, []);
    if (!hooks.ok) throw new Error(hooks.error.code);
    const effects: string[] = [];
    let confirmations = 0;
    const gateway = createProductToolGateway({
      clock,
      resources: createProductResources(clock),
      registry: registry.value,
      runner: {
        execute: async (request) => {
          effects.push(request.effect);
          return { status: "completed", output: { result: "ok" }, effect: "completed" };
        },
      },
      hooks: hooks.value,
      journal,
      correlation,
      turnId: turn,
      disclosedToolNames: new Set(["debug_evaluate"]),
      confirmation: {
        resolve: async (request) => {
          confirmations += 1;
          return { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
      effectLedger: new Map(),
    });
    const execute = (context: "watch" | "repl", suffix: string) =>
      gateway.execute({
        invocationId: invocationId.from(`inv-${suffix}`),
        toolCallId: `call-${suffix}`,
        toolName: "debug_evaluate",
        capabilityId: entry.value.manifest.capabilityId,
        version: 1,
        effect: "interactive",
        input: { context, expression: "value" },
        signal: new AbortController().signal,
      });

    expect((await execute("watch", "watch")).status).toBe("completed");
    expect(confirmations).toBe(0);
    expect((await execute("repl", "repl")).status).toBe("completed");
    expect(confirmations).toBe(1);
    expect(effects).toEqual(["observation", "interactive"]);
  });
});

test("live gateways share manifest capacity across registry generations and workspace bindings", async () => {
  const { tools, clock, eventStore } = setup();
  const journals: ReturnType<typeof createTurnEventJournal>[] = [];
  const resources = createProductResources(clock);
  const source = tools.registry.resolveByName("read_file");
  if (source === null) throw new Error("read_file required");
  const entry = {
    ...source,
    manifest: { ...source.manifest, concurrency: { maxGlobal: 1, maxPerWorkspace: 1 } },
  };
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  let maximum = 0;
  let launches = 0;
  const runner = {
    async execute(request: Parameters<typeof tools.runner.execute>[0]) {
      running++;
      launches++;
      maximum = Math.max(maximum, running);
      if (launches === 1) await held;
      const result = await tools.runner.execute(request);
      running--;
      return result;
    },
  };
  const gateway = (version: number) => {
    const registry = createToolRegistry(configurationGeneration.from(version), [entry]);
    if (!registry.ok) throw new Error("registry required");
    const hooks = createToolHookRegistry(configurationGeneration.from(version), []);
    if (!hooks.ok) throw new Error("hooks required");
    const boundCorrelation = {
      ...correlation,
      configurationGeneration: configurationGeneration.from(version),
      workspaceId: workspaceId.from(`workspace-${version}`),
    };
    const journal = createTurnEventJournal({
      clock,
      eventStore,
      streamId: streamId.from(`session:gateway-${version}`),
      correlation: boundCorrelation,
    });
    journals.push(journal);
    return createProductToolGateway({
      clock,
      resources,
      registry: registry.value,
      runner,
      hooks: hooks.value,
      journal,
      correlation: {
        ...correlation,
        configurationGeneration: configurationGeneration.from(version),
        workspaceId: workspaceId.from(`workspace-${version}`),
      },
      turnId: turnId.from(`turn-${version}`),
      disclosedToolNames: new Set(["read_file"]),
      effectLedger: new Map(),
    });
  };
  const request = (id: string) => ({
    invocationId: invocationId.from(id),
    toolCallId: id,
    toolName: "read_file",
    capabilityId: entry.manifest.capabilityId,
    version: entry.manifest.version,
    effect: entry.manifest.effect,
    input: { path: "a.ts" },
    signal: new AbortController().signal,
  });
  const first = gateway(3).execute(request("first"));
  const second = gateway(4).execute(request("second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(launches).toBe(1);
  release?.();
  const outcomes = await Promise.all([first, second]);
  expect(maximum).toBe(1);
  expect(outcomes).toMatchObject([
    { status: "completed", admission: { released: true } },
    { status: "completed", admission: { released: true } },
  ]);
  for (const journal of journals) {
    const replay = await journal.replay();
    if (replay.kind !== "rebuilt" && replay.kind !== "partial")
      throw new Error("journal replay required");
    const completions = replay.events.filter(
      (event) => event.kind === "capability.invocation.completed",
    );
    expect(completions.length).toBe(1);
    expect(completions.every((event) => event.payload.admission?.acquired)).toBe(true);
  }
});
