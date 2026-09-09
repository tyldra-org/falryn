import { expect, test } from "bun:test";
import { createManualClock, duration } from "../../domain/foundation/index.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  createProductResources,
  type ProductTaskResources,
  type ResourceWork,
} from "./product-resources.ts";

const signal = new AbortController().signal;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const done = async () => ({ value: "ok", terminated: true });
function work(id: string, overrides: Partial<ResourceWork<string>> = {}): ResourceWork<string> {
  return {
    operation: id,
    attempt: "attempt",
    generation: "1",
    inputBytes: 1,
    amounts: { requests: 1 },
    signal,
    run: done,
    unit: {
      id: workUnitId(id),
      effect: "observation",
      priority: "interactive",
      conflictKeys: [],
      dependencies: [],
      deadline: null,
      expectedOutputBytes: 0,
      retry: NO_RETRY,
      scopeId: null,
    },
    ...overrides,
  };
}
function child(parent: ProductTaskResources, limits = {}) {
  const result = parent.subdivide(limits);
  if (!result) throw new Error("child allocation refused");
  return result;
}

test("all nested admissions debit the same cumulative root allowance, including closed aliases", () => {
  const owner = createProductResources(createManualClock());
  const root = owner.openTask("1");
  const first = child(root);
  for (let index = 0; index < 63; index++) child(first).close();
  expect(first.subdivide({})).toBeNull();
  expect(root.subdivide({})).toBeNull();
  root.close();
});

test("child occupancy releases on settlement, cumulative admission facts never refund", async () => {
  const owner = createProductResources(createManualClock());
  const root = owner.openTask("1", { operations: 2 });
  const nested = child(child(root), { concurrency: 1, memoryBytes: 2 });
  const request = (id: string) =>
    nested.execute(
      work(id, {
        amounts: { concurrency: 1, memoryBytes: 2 },
        run: async () => ({
          value: "ok",
          terminated: true,
          actual: { operations: 0, concurrency: 0, memoryBytes: 0 },
        }),
      }),
    );
  expect((await request("one")).kind).toBe("completed");
  expect(nested.remaining("memoryBytes")).toBe(2);
  expect((await request("two")).kind).toBe("completed");
  expect((await request("three")).receipt.state).toBe("limit-exceeded");
  root.close();
});

test("four descendant operations share capacity across sibling and nested scopes", async () => {
  const owner = createProductResources(createManualClock());
  const root = owner.openTask("1");
  const holds = Array.from({ length: 4 }, () =>
    Promise.withResolvers<{ value: string; terminated: boolean }>(),
  );
  const active = holds.map((hold, index) =>
    child(child(root)).execute(work(String(index), { run: () => hold.promise })),
  );
  await flush();
  let launched = false;
  const extra = child(root).execute(
    work("fifth", {
      run: async () => {
        launched = true;
        return done();
      },
    }),
  );
  await flush();
  expect(launched).toBe(false);
  holds[0]?.resolve({ value: "ok", terminated: true });
  expect((await extra).kind).toBe("completed");
  for (const hold of holds) hold.resolve({ value: "ok", terminated: true });
  await Promise.all(active);
  root.close();
});

test("queued work observes child limit and deadline changes before dispatch", async () => {
  const clock = createManualClock();
  const owner = createProductResources(clock, { maxConcurrent: 1 });
  const root = owner.openTask("1");
  const hold = Promise.withResolvers<{ value: string; terminated: boolean }>();
  const active = root.execute(work("held", { run: () => hold.promise }));
  await flush();
  const limited = child(root, { requests: 2 });
  let calls = 0;
  const queued = limited.execute(
    work("queued", {
      run: async () => {
        calls++;
        return done();
      },
    }),
  );
  limited.tighten({ requests: 0 });
  // Closing a different task must not erase this queued child's tightened bucket.
  owner.openTask("1").close();
  hold.resolve({ value: "ok", terminated: true });
  await active;
  expect((await queued).receipt.state).toBe("limit-exceeded");
  expect(calls).toBe(0);
  const expired = child(root, { wallTimeMs: 10 });
  await clock.advance(duration(10));
  expect((await expired.execute(work("expired"))).receipt.state).toBe("admission-timeout");
  root.close();
});

test("unknown usage cannot evade a child ceiling or become zero in a new alias", async () => {
  const owner = createProductResources(createManualClock());
  const root = owner.openTask("1");
  const limited = child(root, { inputTokens: 10 });
  expect(
    (await limited.execute(work("unknown", { unknownDimensions: ["inputTokens"] }))).receipt.state,
  ).toBe("quota-unknown");
  expect((await root.execute(work("unmetered", { unknownDimensions: ["inputTokens"] }))).kind).toBe(
    "completed",
  );
  expect((await child(root, { inputTokens: 100 }).execute(work("alias"))).receipt.state).toBe(
    "quota-unknown",
  );
  root.close();
});

test("a retained closed ancestor cannot gain descendants", () => {
  const owner = createProductResources(createManualClock());
  const root = owner.openTask("1");
  const nested = child(root);
  const release = root.retain();
  root.close();
  expect(nested.subdivide({})).toBeNull();
  release?.();
});
