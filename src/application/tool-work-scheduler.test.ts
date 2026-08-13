import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  authorizeToolInvocation,
  configurationGeneration,
  conflictKey,
  createManualClock,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type EffectClass,
  instant,
  invocationId,
  type ToolInvocationOutcome,
  type ToolManifestDocument,
  validateAndNormalizeInvocations,
} from "../domain/index.ts";
import { createToolWorkScheduler } from "./tool-work-scheduler.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathOutputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function document(effect: EffectClass, name: string): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title: name,
    description: `${effect} tool`,
    effect,
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits({ maxInputBytes: 1024 }),
    concurrency: defaultConcurrencyContract(),
    resultProjection: defaultProjectionContract(),
  };
}

function authorize(
  effect: EffectClass,
  name: string,
  id: string,
  args: Readonly<Record<string, unknown>> = { path: `${name}.ts` },
) {
  const entry = createToolRegistryEntry(document(effect, name), {
    inputSchema: pathSchema,
    outputSchema: pathOutputSchema,
    conflictKeysFor: (input) => [conflictKey("file", String(input.path))],
  });
  expect(entry.ok).toBe(true);
  if (!entry.ok) {
    throw new Error("expected entry");
  }
  const registry = createToolRegistry(generation, [entry.value]);
  expect(registry.ok).toBe(true);
  if (!registry.ok) {
    throw new Error("expected registry");
  }
  const validated = validateAndNormalizeInvocations({
    registry: registry.value,
    proposals: [{ toolCallId: `call-${id}`, name, arguments: args }],
    maxQueued: 8,
    nextInvocationId: () => invocationId.from(id),
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) {
    throw new Error("expected validate");
  }
  const ready = validated.value[0];
  if (ready === undefined) {
    throw new Error("expected invocation");
  }
  if (effect === "observation") {
    const authorized = authorizeToolInvocation({ invocation: ready });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) {
      throw new Error("expected authorize");
    }
    return authorized.value;
  }
  const pending = authorizeToolInvocation({ invocation: ready });
  expect(pending.ok).toBe(false);
  if (pending.ok) {
    throw new Error("expected confirmation");
  }
  expect(pending.decision.decision).toBe("require-confirmation");
  if (pending.decision.decision !== "require-confirmation") {
    throw new Error("expected require-confirmation");
  }
  const authorized = authorizeToolInvocation({
    invocation: ready,
    confirmation: { confirmationId: pending.decision.confirmation.confirmationId },
  });
  expect(authorized.ok).toBe(true);
  if (!authorized.ok) {
    throw new Error("expected confirmed authorize");
  }
  return authorized.value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

describe("createToolWorkScheduler", () => {
  test("executes only through ToolRunnerPort and joins independent observations", async () => {
    const clock = createManualClock(instant(0));
    const seen: string[] = [];
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          seen.push(request.toolName);
          return {
            status: "completed",
            output: { content: request.toolName },
            effect: "completed",
          };
        },
      },
    });

    const result = await scheduler.run({
      items: [
        { authorized: authorize("observation", "read_a", "inv-a") },
        { authorized: authorize("observation", "read_b", "inv-b") },
      ],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") {
      return;
    }
    expect(result.records.map((record) => record.outcome.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(seen.sort()).toEqual(["read_a", "read_b"]);
    expect(result.effect).toBe("completed");
  });

  test("serializes mutations that share a conflict key", async () => {
    const clock = createManualClock(instant(0));
    let concurrent = 0;
    let maxConcurrent = 0;
    const first = deferred<ToolInvocationOutcome>();
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (request.toolCallId === "call-inv-1") {
            const outcome = await first.promise;
            concurrent -= 1;
            return outcome;
          }
          concurrent -= 1;
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
    });

    const pending = scheduler.run({
      items: [
        { authorized: authorize("mutation", "write_file", "inv-1", { path: "same.ts" }) },
        { authorized: authorize("mutation", "write_file", "inv-2", { path: "same.ts" }) },
      ],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(maxConcurrent).toBe(1);
    first.resolve({ status: "completed", output: {}, effect: "completed" });
    const result = await pending;
    expect(result.kind).toBe("completed");
    expect(maxConcurrent).toBe(1);
  });

  test("runs a dependent invocation only after its prerequisite completes", async () => {
    const clock = createManualClock(instant(0));
    const order: string[] = [];
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          order.push(request.toolCallId);
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
    });
    const parent = authorize("observation", "read_a", "inv-a");
    const child = authorize("observation", "read_b", "inv-b");
    const result = await scheduler.run({
      items: [
        { authorized: child, dependencies: [parent.invocation.invocationId] },
        { authorized: parent },
      ],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    expect(order).toEqual(["call-inv-a", "call-inv-b"]);
  });

  test("cancels in-flight work and reports no effect for observations", async () => {
    const clock = createManualClock(instant(0));
    const started = deferred<void>();
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "cancelled", effect: "none" };
        },
      },
    });
    const controller = new AbortController();
    const pending = scheduler.run({
      items: [{ authorized: authorize("observation", "read_a", "inv-a") }],
      joinPolicy: "all",
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") {
      return;
    }
    expect(result.records[0]?.outcome.status).toBe("cancelled");
    expect(result.records[0]?.outcome).toMatchObject({ effect: "none" });
  });

  test("skips dependents after a failed prerequisite without executing them", async () => {
    const clock = createManualClock(instant(0));
    const seen: string[] = [];
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          seen.push(request.toolCallId);
          return { status: "failed", reason: "boom", effect: "none" };
        },
      },
    });
    const parent = authorize("observation", "read_a", "inv-a");
    const child = authorize("observation", "read_b", "inv-b");
    const result = await scheduler.run({
      items: [
        { authorized: parent },
        { authorized: child, dependencies: [parent.invocation.invocationId] },
      ],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") {
      return;
    }
    expect(seen).toEqual(["call-inv-a"]);
    expect(
      result.records.find((record) => record.toolCallId === "call-inv-a")?.outcome.status,
    ).toBe("failed");
    expect(
      result.records.find((record) => record.toolCallId === "call-inv-b")?.outcome.status,
    ).toBe("unavailable");
  });

  test("fail-fast aborts remaining work after a failed prerequisite", async () => {
    const clock = createManualClock(instant(0));
    const seen: string[] = [];
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          seen.push(request.toolCallId);
          return { status: "failed", reason: "boom", effect: "none" };
        },
      },
    });
    const parent = authorize("observation", "read_a", "inv-a");
    const child = authorize("observation", "read_b", "inv-b");
    const result = await scheduler.run({
      items: [
        { authorized: parent },
        { authorized: child, dependencies: [parent.invocation.invocationId] },
      ],
      joinPolicy: "fail-fast",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") {
      return;
    }
    expect(seen).toEqual(["call-inv-a"]);
    expect(
      result.records.find((record) => record.toolCallId === "call-inv-a")?.outcome.status,
    ).toBe("failed");
    const childStatus = result.records.find((record) => record.toolCallId === "call-inv-b")?.outcome
      .status;
    expect(childStatus === "cancelled" || childStatus === "unavailable").toBe(true);
  });

  test("times out through abortAs without claiming a completed mutation", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async (request) => {
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "timed-out", effect: "uncertain" };
        },
      },
    });
    const controller = new AbortController();
    const pending = scheduler.run({
      items: [{ authorized: authorize("mutation", "write_file", "inv-1") }],
      joinPolicy: "all",
      signal: controller.signal,
      abortAs: "timeout",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") {
      return;
    }
    expect(result.records[0]?.outcome.status).toBe("timed-out");
    expect(result.records[0]?.outcome).toMatchObject({ effect: "uncertain" });
  });

  test("rejects a cycle before the runner executes", async () => {
    const clock = createManualClock(instant(0));
    let executed = 0;
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async () => {
          executed += 1;
          return { status: "completed", output: {}, effect: "completed" };
        },
      },
    });
    const first = authorize("observation", "read_a", "inv-a");
    const second = authorize("observation", "read_b", "inv-b");
    const result = await scheduler.run({
      items: [
        { authorized: first, dependencies: [second.invocation.invocationId] },
        { authorized: second, dependencies: [first.invocation.invocationId] },
      ],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("rejected");
    expect(executed).toBe(0);
    if (result.kind === "rejected") {
      expect(result.error.code).toBe("dependency-cycle");
      expect(result.effect).toBe("none");
    }
  });
});
