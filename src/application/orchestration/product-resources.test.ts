import { describe, expect, test } from "bun:test";
import { createManualClock, deadlineAt, duration, instant } from "../../domain/foundation/index.ts";
import { NO_RETRY, type WorkUnit, workUnitId } from "../../domain/orchestration/work.ts";
import {
  capacityScope,
  createProductResources,
  type ProductTaskResources,
} from "./product-resources.ts";

function unit(id: string, priority: WorkUnit["priority"] = "interactive"): WorkUnit {
  return {
    id: workUnitId(id),
    priority,
    effect: "observation",
    conflictKeys: [],
    dependencies: [],
    deadline: null,
    expectedOutputBytes: 0,
    retry: NO_RETRY,
    scopeId: null,
  };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function request(
  task: ProductTaskResources,
  id: string,
  run: () => Promise<{ value: string; terminated: boolean }>,
  signal = new AbortController().signal,
) {
  return task.execute({
    operation: id,
    attempt: "a",
    generation: "1",
    unit: unit(id),
    inputBytes: 1,
    amounts: { requests: 1 },
    signal,
    run,
  });
}
describe("product resource owner", () => {
  test("simultaneous tasks share occupancy; queued cancellation never launches", async () => {
    const clock = createManualClock();
    const owner = createProductResources(clock, { maxConcurrent: 1 });
    const first = owner.openTask("1");
    const second = owner.openTask("1");
    const held = deferred<{ value: string; terminated: boolean }>();
    let launches = 0;
    const active = request(first, "one", () => held.promise);
    const cancelled = new AbortController();
    const queued = request(
      second,
      "two",
      async () => {
        launches++;
        return { value: "two", terminated: true };
      },
      cancelled.signal,
    );
    await flush();
    cancelled.abort();
    expect((await queued).receipt.state).toBe("cancelled");
    expect(launches).toBe(0);
    held.resolve({ value: "one", terminated: true });
    expect((await active).kind).toBe("completed");
    first.close();
    second.close();
    expect(owner.report().tasks).toBe(0);
    expect(owner.report().uncertain).toBe(0);
  });
  test("active cancellation cannot mint capacity and late completion reconciles once", async () => {
    const clock = createManualClock();
    const owner = createProductResources(clock, { maxConcurrent: 1 });
    const task = owner.openTask("1", { requests: 3 });
    const held = deferred<{ value: string; terminated: boolean }>();
    const abort = new AbortController();
    const active = request(task, "one", () => held.promise, abort.signal);
    await flush();
    abort.abort();
    expect((await active).receipt.state).toBe("uncertain-after-interruption");
    let launches = 0;
    const next = request(task, "two", async () => {
      launches++;
      return { value: "two", terminated: true };
    });
    await flush();
    expect(launches).toBe(0);
    expect(owner.report().uncertain).toBe(1);
    held.resolve({ value: "late", terminated: true });
    expect((await next).kind).toBe("completed");
    expect(launches).toBe(1);
    expect(task.remaining("requests")).toBe(1);
    task.close();
  });
  test("continuation, fallback, exact replay and changed bindings share one allowance", async () => {
    const owner = createProductResources(createManualClock());
    const task = owner.openTask("1", { requests: 2 });
    let calls = 0;
    const run = async () => {
      calls++;
      return { value: "ok", terminated: true };
    };
    expect((await request(task, "one", run)).kind).toBe("completed");
    expect((await request(task, "one", run)).kind).toBe("replayed");
    expect(calls).toBe(1);
    expect(
      (
        await task.execute({
          operation: "two",
          attempt: "fallback",
          generation: "1",
          unit: unit("two"),
          inputBytes: 1,
          amounts: { requests: 1 },
          signal: new AbortController().signal,
          run,
        })
      ).kind,
    ).toBe("completed");
    expect((await request(task, "three", run)).receipt.state).toBe("limit-exceeded");
    expect(
      (
        await task.execute({
          operation: "one",
          attempt: "a",
          generation: "2",
          unit: unit("one"),
          inputBytes: 1,
          amounts: {},
          signal: new AbortController().signal,
          run,
        })
      ).receipt.state,
    ).toBe("stale-generation");
    task.close();
    expect((await request(task, "four", run)).receipt.state).toBe("stale-generation");
  });
  test("queued deadline expires without a runner, and shutdown wakes queued work", async () => {
    const clock = createManualClock();
    const owner = createProductResources(clock, { maxConcurrent: 1 });
    const task = owner.openTask("1");
    const held = deferred<{ value: string; terminated: boolean }>();
    const active = request(task, "one", () => held.promise);
    let calls = 0;
    const queued = task.execute({
      operation: "two",
      attempt: "a",
      generation: "1",
      unit: { ...unit("two"), deadline: deadlineAt(instant(10)) },
      inputBytes: 1,
      amounts: {},
      signal: new AbortController().signal,
      run: async () => {
        calls++;
        return { value: "bad", terminated: true };
      },
    });
    await clock.advance(duration(10));
    expect((await queued).receipt.state).toBe("admission-timeout");
    expect(calls).toBe(0);
    const shutdownQueued = request(task, "three", async () => {
      calls++;
      return { value: "bad", terminated: true };
    });
    owner.shutdown();
    expect((await shutdownQueued).receipt.state).toBe("shutdown");
    await active;
    expect(calls).toBe(0);
    held.resolve({ value: "late", terminated: true });
    await flush();
    expect(owner.report().uncertain).toBe(0);
  });
  test("manifest family limits survive workspace and registry generation changes", async () => {
    const clock = createManualClock();
    const owner = createProductResources(clock);
    const first = owner.openTask("1");
    const second = owner.openTask("2");
    const scopes = [
      {
        scope: capacityScope("tool", "falryn", "builtin:fs/read", "concurrency", "occupancy"),
        amount: 1,
        limit: 1,
      },
    ];
    const held = deferred<{ value: string; terminated: boolean }>();
    let calls = 0;
    const start = (
      task: ProductTaskResources,
      generation: string,
      operation: string,
      run: () => Promise<{ value: string; terminated: boolean }>,
    ) =>
      task.execute({
        operation,
        attempt: "a",
        generation,
        unit: unit(operation),
        inputBytes: 1,
        amounts: {},
        scopes,
        signal: new AbortController().signal,
        run,
      });
    const active = start(first, "1", "one", () => held.promise);
    const queued = start(second, "2", "two", async () => {
      calls++;
      return { value: "ok", terminated: true };
    });
    await flush();
    expect(calls).toBe(0);
    held.resolve({ value: "ok", terminated: true });
    await active;
    await queued;
    expect(calls).toBe(1);
    first.close();
    second.close();
  });
});

test("interactive headroom and cross-generation aging progress under background load", async () => {
  const clock = createManualClock();
  const owner = createProductResources(clock, { maxConcurrent: 2 });
  const task = owner.openTask("1");
  const blocker = deferred<{ value: string; terminated: boolean }>();
  const work = (
    id: string,
    priority: WorkUnit["priority"],
    run: () => Promise<{ value: string; terminated: boolean }>,
  ) =>
    task.execute({
      operation: id,
      attempt: "a",
      generation: "1",
      unit: unit(id, priority),
      inputBytes: 1,
      amounts: {},
      signal: new AbortController().signal,
      run,
    });
  const active = work("background", "active-turn", () => blocker.promise);
  let maintained = false;
  const maintenance = work("maintenance", "maintenance", async () => {
    maintained = true;
    return { value: "maintained", terminated: true };
  });
  for (let index = 0; index < 25; index++) {
    expect(
      (
        await work(`interactive-${index}`, "interactive", async () => ({
          value: "ok",
          terminated: true,
        }))
      ).kind,
    ).toBe("completed");
  }
  await maintenance;
  expect(maintained).toBe(true);
  blocker.resolve({ value: "done", terminated: true });
  await active;
  task.close();
});

test("queue byte bounds reject before execution without charging the task", async () => {
  const owner = createProductResources(createManualClock());
  const task = owner.openTask("1");
  let called = false;
  const result = await task.execute({
    operation: "large",
    attempt: "a",
    generation: "1",
    unit: unit("large"),
    inputBytes: 17 * 1024 * 1024,
    amounts: { requests: 1 },
    signal: new AbortController().signal,
    run: async () => {
      called = true;
      return { value: "bad", terminated: true };
    },
  });
  expect(result.receipt.state).toBe("limit-exceeded");
  expect(called).toBe(false);
  expect(task.remaining("requests")).toBe(64);
  task.close();
});

test("child allocations subdivide remaining parent capacity", async () => {
  const owner = createProductResources(createManualClock());
  const task = owner.openTask("1", { requests: 3 });
  const child = task.subdivide({ requests: 2 });
  const sibling = task.subdivide({ requests: 3 });
  if (child === null || sibling === null) throw new Error("children should open");
  const run = async () => ({ value: "ok", terminated: true });
  await request(child, "first", run);
  await request(child, "second", run);
  expect((await request(child, "third", run)).receipt.state).toBe("limit-exceeded");
  expect(sibling.remaining("requests")).toBe(1);
  await request(sibling, "last", run);
  expect((await request(task, "overflow", run)).receipt.state).toBe("limit-exceeded");
  task.close();
});

test("a later role limit cannot turn previous unknown usage into zero", async () => {
  const owner = createProductResources(createManualClock());
  const task = owner.openTask("1");
  await task.execute({
    operation: "unknown",
    attempt: "a",
    generation: "1",
    unit: unit("unknown"),
    inputBytes: 1,
    amounts: { requests: 1 },
    unknownDimensions: ["inputTokens"],
    signal: new AbortController().signal,
    run: async () => ({ value: "ok", terminated: true }),
  });
  task.tighten({ inputTokens: 100 });
  expect(
    (await request(task, "fallback", async () => ({ value: "bad", terminated: true }))).receipt
      .state,
  ).toBe("quota-unknown");
  task.close();
});
