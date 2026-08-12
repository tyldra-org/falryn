import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  capabilityId,
  configurationGeneration,
  createToolCatalog,
  sessionId,
  type ToolDescriptor,
  type ToolInvocationOutcome,
  type ToolProposal,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import {
  createToolCallLoop,
  type ToolRunnerPort,
  type ToolRunnerRequest,
} from "./tool-call-loop.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function readFileDescriptor(): ToolDescriptor {
  return {
    id: capabilityId.from("workspace.read"),
    version: 1,
    name: "read_file",
    effect: "observation",
    inputSchema: pathSchema,
  };
}

function writeFileDescriptor(): ToolDescriptor {
  return {
    id: capabilityId.from("workspace.write"),
    version: 1,
    name: "write_file",
    effect: "mutation",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict() as z.ZodType<
      Readonly<Record<string, unknown>>
    >,
  };
}

function startAtHandlingModelEvent() {
  const coordinator = createTurnCoordinator();
  const id = turnId.from("turn-tools-1");
  expect(
    coordinator.start({
      turnId: id,
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    }).ok,
  ).toBe(true);
  for (const command of [
    "begin-orienting",
    "begin-assembling-context",
    "begin-awaiting-model",
    "begin-handling-model-event",
  ] as const) {
    expect(
      coordinator.apply({
        turnId: id,
        command,
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
  }
  return { coordinator, turnId: id };
}

function successRunner(
  handler?: (request: ToolRunnerRequest) => Promise<ToolInvocationOutcome> | ToolInvocationOutcome,
): ToolRunnerPort {
  return {
    async execute(request) {
      if (handler !== undefined) {
        return await handler(request);
      }
      return {
        status: "completed",
        output: { ok: true, path: request.input.path },
        effect: "completed",
      };
    },
  };
}

describe("tool call loop", () => {
  test("executes validated proposals through the runner and completes the turn", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: successRunner(),
    });

    const proposals: ToolProposal[] = [
      { toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } },
    ];

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      return;
    }
    expect(outcome.iterations).toBe(1);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.outcome.status).toBe("completed");
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
  });

  test("iterates tool → model → tool until continueModel stops", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const seen: string[] = [];
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: successRunner((request) => {
        seen.push(String(request.input.path));
        return {
          status: "completed",
          output: { path: request.input.path },
          effect: "completed",
        };
      }),
      limits: { maxIterations: 4 },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "first.ts" } }],
      signal: new AbortController().signal,
      async continueModel(context) {
        if (context.iteration >= 2) {
          return { kind: "stop" };
        }
        return {
          kind: "continue",
          proposals: [
            {
              toolCallId: `call-${context.iteration + 1}`,
              name: "read_file",
              arguments: { path: "second.ts" },
            },
          ],
        };
      },
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      return;
    }
    expect(outcome.iterations).toBe(2);
    expect(seen).toEqual(["first.ts", "second.ts"]);
    expect(outcome.results).toHaveLength(2);
  });

  test("fails closed when max iterations are exceeded", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: successRunner(),
      limits: { maxIterations: 2 },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      signal: new AbortController().signal,
      async continueModel(context) {
        return {
          kind: "continue",
          proposals: [
            {
              toolCallId: `call-${context.iteration + 1}`,
              name: "read_file",
              arguments: { path: `n${context.iteration}.ts` },
            },
          ],
        };
      },
    });

    expect(outcome.kind).toBe("bound-exceeded");
    if (outcome.kind !== "bound-exceeded") {
      return;
    }
    expect(outcome.bound).toBe("max-iterations");
    expect(outcome.maximum).toBe(2);
    expect(outcome.iterations).toBe(2);
  });

  test("fails closed when the per-iteration queue bound is exceeded", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: successRunner(),
      limits: { maxToolCallsPerIteration: 1 },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [
        { toolCallId: "a", name: "read_file", arguments: { path: "a.ts" } },
        { toolCallId: "b", name: "read_file", arguments: { path: "b.ts" } },
      ],
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("bound-exceeded");
    if (outcome.kind !== "bound-exceeded") {
      return;
    }
    expect(outcome.bound).toBe("max-tool-calls-per-iteration");
  });

  test("reports unavailable for unknown tools without calling the runner", async () => {
    let calls = 0;
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: {
        async execute() {
          calls += 1;
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [{ toolCallId: "call-1", name: "nope", arguments: {} }],
      signal: new AbortController().signal,
    });

    expect(calls).toBe(0);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") {
      return;
    }
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "failed", effect: "none" },
    });
  });

  test("reports malformed for schema failures without calling the runner", async () => {
    let calls = 0;
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: {
        async execute() {
          calls += 1;
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: 9 } }],
      signal: new AbortController().signal,
    });

    expect(calls).toBe(0);
    expect(outcome.kind).toBe("malformed");
  });

  test("aborts in-flight tools and does not report before cleanup", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const controller = new AbortController();
    let started = 0;
    let finished = 0;
    let releaseWork: (() => void) | undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let bothStarted: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [writeFileDescriptor()]),
      runner: {
        async execute(request) {
          started += 1;
          if (started === 2) {
            bothStarted?.();
          }
          await workGate;
          finished += 1;
          if (request.signal.aborted) {
            return { status: "cancelled", effect: "uncertain" };
          }
          return {
            status: "completed",
            output: { wrote: true },
            effect: "completed",
          };
        },
      },
      limits: { maxConcurrentTools: 2 },
    });

    const runPromise = loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [
        {
          toolCallId: "call-1",
          name: "write_file",
          arguments: { path: "a.ts", content: "a" },
        },
        {
          toolCallId: "call-2",
          name: "write_file",
          arguments: { path: "b.ts", content: "b" },
        },
      ],
      signal: controller.signal,
    });

    await startedGate;
    expect(started).toBe(2);
    expect(finished).toBe(0);
    controller.abort();
    // Loop must still be awaiting cleanup — finished stays 0 until work releases.
    expect(finished).toBe(0);
    releaseWork?.();
    const outcome = await runPromise;
    expect(finished).toBe(2);
    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind !== "uncertain") {
      return;
    }
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
  });

  test("respects max concurrent tools", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    let inFlight = 0;
    let peak = 0;

    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: {
        async execute() {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
      limits: { maxConcurrentTools: 2 },
    });

    const proposals: ToolProposal[] = Array.from({ length: 6 }, (_, index) => ({
      toolCallId: `call-${index}`,
      name: "read_file",
      arguments: { path: `${index}.ts` },
    }));

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("completed");
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("propagates denied runner outcomes", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [writeFileDescriptor()]),
      runner: {
        async execute() {
          return { status: "denied", reason: "confirmation required", effect: "none" };
        },
      },
    });

    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [
        {
          toolCallId: "call-1",
          name: "write_file",
          arguments: { path: "a.ts", content: "x" },
        },
      ],
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("denied");
  });

  test("settles timeout aborts as timed-out when not forced uncertain", async () => {
    const { coordinator, turnId: id } = startAtHandlingModelEvent();
    const controller = new AbortController();
    controller.abort();

    const loop = createToolCallLoop({
      coordinator,
      catalog: createToolCatalog(generation, [readFileDescriptor()]),
      runner: successRunner(),
    });

    // Already aborted before tools run: still in executing-capability, so
    // cancel path is uncertain; timeout path reports timed-out.
    const outcome = await loop.run({
      turnId: id,
      configurationGeneration: generation,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      signal: controller.signal,
      abortAs: "timeout",
    });

    expect(outcome.kind).toBe("timed-out");
    if (outcome.kind !== "timed-out") {
      return;
    }
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "timed-out" },
    });
  });
});
