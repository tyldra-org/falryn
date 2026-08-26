import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createManualClock,
  createStubCommandRunner,
  createToolHookRegistry,
  instant,
  invocationId,
  localPath,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createProductToolGateway } from "./product-tool-gateway.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";
import { createTurnEventJournal } from "./turn-event-journal.ts";

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
      registry: tools.registry,
      runner: tools.runner,
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
    expect(hookPoints).toEqual(["before-capability-invocation", "after-capability-invocation"]);
    const replay = await journal.replay();
    expect(replay.kind === "rebuilt" || replay.kind === "partial").toBe(true);
    if (replay.kind === "rebuilt" || replay.kind === "partial") {
      expect(replay.events.map((event) => event.kind)).toEqual([
        "capability.invocation.started",
        "capability.invocation.completed",
      ]);
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
});
