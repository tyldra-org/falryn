import { describe, expect, test } from "bun:test";

import {
  type BudgetId,
  type ConflictKey,
  conflictKey,
  createManualClock,
  deadlineAt,
  duration,
  type EffectClass,
  effectiveConflictKeys,
  effectOf,
  instant,
  NO_RETRY,
  type PriorityClass,
  type WorkUnit,
  type WorkUnitId,
  workUnitId,
} from "../domain/index.ts";
import { createBudgetLedger } from "./budget-ledger.ts";
import { createScheduler } from "./scheduler.ts";

type UnitOverrides = Partial<Omit<WorkUnit, "id">>;

function unit(id: string, overrides: UnitOverrides = {}): WorkUnit {
  return {
    id: workUnitId(id),
    effect: "observation",
    priority: "active-turn",
    conflictKeys: [],
    dependencies: [],
    deadline: null,
    expectedOutputBytes: 0,
    retry: NO_RETRY,
    scopeId: null,
    ...overrides,
  };
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

/** Lets pending microtasks and the scheduler loop settle without moving the clock. */
async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("conflict keys", () => {
  test("normalize equivalent targets onto one key", () => {
    const canonical = conflictKey("file", "/repo/src/main.ts");
    expect(conflictKey("file", "/repo//src/main.ts")).toBe(canonical);
    expect(conflictKey("file", "/repo/src/./main.ts")).toBe(canonical);
    expect(conflictKey("file", "/repo/lib/../src/main.ts")).toBe(canonical);
    expect(conflictKey("FILE", "  /repo/src/main.ts  ")).toBe(canonical);
    expect(conflictKey("file", "\\repo\\src\\main.ts")).toBe(canonical);
  });

  test("distinct targets stay distinct", () => {
    expect(conflictKey("file", "/a")).not.toBe(conflictKey("file", "/b"));
    expect(conflictKey("file", "/a")).not.toBe(conflictKey("git", "/a"));
  });

  test("an observation with no declared key is freely parallel", () => {
    expect(effectiveConflictKeys(unit("read", { effect: "observation" }))).toEqual([]);
  });

  test.each<EffectClass>(["mutation", "external", "interactive"])(
    "a %s with no declared key is serialized globally",
    (effect) => {
      const keys = effectiveConflictKeys(unit("write", { effect }));
      expect(keys).toEqual(["global:*" as ConflictKey]);
    },
  );
});

describe("conflict serialization", () => {
  test("two mutations on one key run one at a time", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const key = conflictKey("file", "/repo/a.ts");
    const first = deferred<string>();
    const log: string[] = [];

    const pending = scheduler.schedule([
      {
        unit: unit("w1", { effect: "mutation", conflictKeys: [key] }),
        run: () => {
          log.push("w1:start");
          return first.promise;
        },
      },
      {
        unit: unit("w2", { effect: "mutation", conflictKeys: [key] }),
        run: () => {
          log.push("w2:start");
          return Promise.resolve("w2");
        },
      },
    ]);

    await flush();
    expect(log).toEqual(["w1:start"]);

    first.resolve("w1");
    await flush();
    const results = await pending;

    expect(log).toEqual(["w1:start", "w2:start"]);
    expect(results.every((result) => result.kind === "completed")).toBe(true);
  });

  test("observations on distinct keys run concurrently", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const gates = [deferred<string>(), deferred<string>()];
    const started: string[] = [];

    const pending = scheduler.schedule(
      ["r1", "r2"].map((id, index) => ({
        unit: unit(id, { conflictKeys: [conflictKey("file", `/repo/${id}.ts`)] }),
        run: () => {
          started.push(id);
          return gates[index]?.promise ?? Promise.resolve(id);
        },
      })),
    );

    await flush();
    expect(started).toEqual(["r1", "r2"]);

    for (const gate of gates) {
      gate.resolve("done");
    }
    await pending;
  });

  test("a keyless mutation is not parallelized with another", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const first = deferred<string>();
    const started: string[] = [];

    const pending = scheduler.schedule([
      {
        unit: unit("m1", { effect: "mutation" }),
        run: () => {
          started.push("m1");
          return first.promise;
        },
      },
      {
        unit: unit("m2", { effect: "mutation" }),
        run: () => {
          started.push("m2");
          return Promise.resolve("m2");
        },
      },
    ]);

    await flush();
    expect(started).toEqual(["m1"]);

    first.resolve("m1");
    await flush();
    await pending;
    expect(started).toEqual(["m1", "m2"]);
  });

  test.each([
    ["completed", () => Promise.resolve("ok")],
    ["failed", () => Promise.reject(new Error("boom"))],
  ])("releases its key on the %s path", async (_label, run) => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const key = conflictKey("file", "/repo/a.ts");

    await scheduler.submit(unit("first", { effect: "mutation", conflictKeys: [key] }), run);
    expect(scheduler.report().heldKeys).toEqual([]);

    const second = await scheduler.submit(
      unit("second", { effect: "mutation", conflictKeys: [key] }),
      () => Promise.resolve("ok"),
    );
    expect(second.kind).toBe("completed");
  });

  test("releases its key on the timed-out path", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const key = conflictKey("file", "/repo/a.ts");

    const pending = scheduler.submit(
      unit("slow", {
        effect: "mutation",
        conflictKeys: [key],
        deadline: deadlineAt(instant(100)),
      }),
      () => new Promise<string>(() => {}),
    );
    await clock.runUntilIdle();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.outcome.kind).toBe("timed-out");
    }
    expect(scheduler.report().heldKeys).toEqual([]);
  });

  test("releases its key on the cancelled path", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const controller = new AbortController();
    const key = conflictKey("file", "/repo/a.ts");

    const pending = scheduler.submit(
      unit("blocked", { effect: "mutation", conflictKeys: [key] }),
      () => new Promise<string>(() => {}),
      controller.signal,
    );
    await flush();
    controller.abort();
    await flush();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.outcome.kind).toBe("cancelled");
    }
    expect(scheduler.report().heldKeys).toEqual([]);
  });

  test("a contended lock past its acquisition deadline is refused with no effect", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({
      clock,
      limits: { lockAcquisitionTimeoutMs: 50 },
    });
    const key = conflictKey("file", "/repo/a.ts");
    const holder = deferred<string>();

    const pending = scheduler.schedule([
      {
        unit: unit("holder", { effect: "mutation", conflictKeys: [key] }),
        run: () => holder.promise,
      },
      {
        unit: unit("waiter", { effect: "mutation", conflictKeys: [key] }),
        run: () => Promise.resolve("waiter"),
      },
    ]);

    await flush();
    await clock.advance(duration(51));
    await flush();
    holder.resolve("holder");
    const results = await pending;

    const waiter = results.find((result) => result.unitId === ("waiter" as WorkUnitId));
    expect(waiter?.kind).toBe("refused");
    if (waiter?.kind === "refused") {
      expect(waiter.error.code).toBe("lock-acquisition-timeout");
      expect(effectOf(waiter.outcome)).toBe("none");
      expect(waiter.recovery).toContain("await-competing-work");
    }
  });
});

describe("dependency graph", () => {
  test("runs dependents after their dependency completes", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const order: string[] = [];

    const pending = scheduler.schedule([
      {
        unit: unit("b", { dependencies: [workUnitId("a")] }),
        run: () => {
          order.push("b");
          return Promise.resolve("b");
        },
      },
      {
        unit: unit("a"),
        run: () => {
          order.push("a");
          return Promise.resolve("a");
        },
      },
    ]);

    await flush();
    await pending;
    expect(order).toEqual(["a", "b"]);
  });

  test("a failed dependency refuses its dependents with no effect", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });

    const pending = scheduler.schedule([
      { unit: unit("a"), run: () => Promise.reject(new Error("boom")) },
      { unit: unit("b", { dependencies: [workUnitId("a")] }), run: () => Promise.resolve("b") },
    ]);

    await flush();
    const results = await pending;
    const dependent = results.find((result) => result.unitId === ("b" as WorkUnitId));

    expect(dependent?.kind).toBe("refused");
    if (dependent?.kind === "refused") {
      expect(dependent.error.code).toBe("dependency-failed");
      expect(effectOf(dependent.outcome)).toBe("none");
      expect(dependent.recovery).toContain("resubmit-without-failed-dependency");
    }
  });

  test("a cycle is rejected before anything runs", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const started: string[] = [];

    const results = await scheduler.schedule([
      {
        unit: unit("a", { dependencies: [workUnitId("b")] }),
        run: () => {
          started.push("a");
          return Promise.resolve("a");
        },
      },
      {
        unit: unit("b", { dependencies: [workUnitId("a")] }),
        run: () => {
          started.push("b");
          return Promise.resolve("b");
        },
      },
    ]);

    expect(started).toEqual([]);
    expect(results.every((result) => result.kind === "refused")).toBe(true);
    const first = results[0];
    if (first?.kind === "refused" && first.error.code === "dependency-cycle") {
      expect(first.error.units.length).toBeGreaterThan(0);
    }
  });

  test("an edge pointing outside the generation is rejected before anything runs", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const started: string[] = [];

    const results = await scheduler.schedule([
      {
        unit: unit("a", { dependencies: [workUnitId("elsewhere")] }),
        run: () => {
          started.push("a");
          return Promise.resolve("a");
        },
      },
    ]);

    expect(started).toEqual([]);
    const first = results[0];
    expect(first?.kind).toBe("refused");
    if (first?.kind === "refused") {
      expect(first.error.code).toBe("unknown-dependency");
    }
  });
});

describe("concurrency caps", () => {
  test("holds the global cap exactly", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 2 } });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: string[] = [];

    const pending = scheduler.schedule(
      ["a", "b", "c"].map((id, index) => ({
        unit: unit(id),
        run: () => {
          started.push(id);
          return gates[index]?.promise ?? Promise.resolve(id);
        },
      })),
    );

    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.report().running).toBe(2);

    gates[0]?.resolve("a");
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    gates[1]?.resolve("b");
    gates[2]?.resolve("c");
    await pending;
    expect(scheduler.report().running).toBe(0);
  });

  test("holds the per-key cap even when the global cap has room", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 8 } });
    const key = conflictKey("git", "/repo");
    const gate = deferred<string>();
    const started: string[] = [];

    const pending = scheduler.schedule(
      ["a", "b", "c"].map((id, index) => ({
        unit: unit(id, { effect: "mutation", conflictKeys: [key] }),
        run: () => {
          started.push(id);
          return index === 0 ? gate.promise : Promise.resolve(id);
        },
      })),
    );

    await flush();
    expect(started).toEqual(["a"]);

    gate.resolve("a");
    await flush();
    await pending;
    expect(started).toEqual(["a", "b", "c"]);
  });
});

describe("priority and fairness", () => {
  test("admits the four classes in order", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 1 } });
    const started: string[] = [];
    const classes: PriorityClass[] = [
      "maintenance",
      "user-visible-background",
      "active-turn",
      "interactive",
    ];

    const pending = scheduler.schedule(
      classes.map((priority) => ({
        unit: unit(priority, { priority }),
        run: () => {
          started.push(priority);
          return Promise.resolve(priority);
        },
      })),
    );

    await flush(20);
    await pending;
    expect(started).toEqual([
      "interactive",
      "active-turn",
      "user-visible-background",
      "maintenance",
    ]);
  });

  test("sustained interactive load still lets maintenance make progress", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({
      clock,
      limits: { maxConcurrent: 1, starvationThreshold: 3 },
    });
    const started: string[] = [];

    const work = [
      {
        unit: unit("maintenance", { priority: "maintenance" as PriorityClass }),
        id: "maintenance",
      },
      ...Array.from({ length: 12 }, (_value, index) => ({
        unit: unit(`interactive-${index}`, { priority: "interactive" as PriorityClass }),
        id: `interactive-${index}`,
      })),
    ];

    const pending = scheduler.schedule(
      work.map((item) => ({
        unit: item.unit,
        run: () => {
          started.push(item.id);
          return Promise.resolve(item.id);
        },
      })),
    );

    await flush(40);
    await pending;

    const position = started.indexOf("maintenance");
    expect(position).toBeGreaterThanOrEqual(0);
    // Aged ahead of interactive work still waiting, rather than left until last.
    expect(position).toBeLessThan(started.length - 1);
    expect(scheduler.report().promotions).toBeGreaterThan(0);
    // Interactive work still went first for as long as the threshold allowed.
    expect(started[0]).toBe("interactive-0");
  });

  test("priority never exempts a unit from a conflict key", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 8 } });
    const key = conflictKey("file", "/repo/shared.ts");
    const gate = deferred<string>();
    const started: string[] = [];

    const pending = scheduler.schedule([
      {
        unit: unit("maintenance", {
          priority: "maintenance",
          effect: "mutation",
          conflictKeys: [key],
        }),
        run: () => {
          started.push("maintenance");
          return Promise.resolve("maintenance");
        },
      },
      {
        unit: unit("interactive", {
          priority: "interactive",
          effect: "mutation",
          conflictKeys: [key],
        }),
        run: () => {
          started.push("interactive");
          return gate.promise;
        },
      },
    ]);

    await flush();
    // The interactive unit sorts first and takes the key. The maintenance unit
    // waits for the key even though nothing else is running — priority orders,
    // it does not exempt.
    expect(started).toEqual(["interactive"]);
    expect(scheduler.report().running).toBe(1);

    gate.resolve("interactive");
    await flush();
    await pending;
    expect(started).toEqual(["interactive", "maintenance"]);
  });
});

describe("budgets", () => {
  test("exhaustion refuses with a typed limit and a recovery option", async () => {
    const clock = createManualClock(instant(0));
    const ledger = createBudgetLedger();
    const budgetId = "turn-budget" as BudgetId;
    ledger.createRoot(budgetId, { operations: 1 });

    const scheduler = createScheduler<string>({
      clock,
      limits: { maxConcurrent: 1 },
      budget: { ledger, budgetId },
    });

    const results = await scheduler.schedule([
      { unit: unit("a"), run: () => Promise.resolve("a") },
      { unit: unit("b"), run: () => Promise.resolve("b") },
    ]);

    const refused = results.find((result) => result.kind === "refused");
    expect(refused?.kind).toBe("refused");
    if (refused?.kind === "refused") {
      expect(refused.error.code).toBe("budget-exhausted");
      expect(effectOf(refused.outcome)).toBe("none");
      expect(refused.recovery).toContain("raise-limit");
    }
  });

  test("a completed unit consumes its reservation and a refused one leaves none open", async () => {
    const clock = createManualClock(instant(0));
    const ledger = createBudgetLedger();
    const budgetId = "turn-budget" as BudgetId;
    ledger.createRoot(budgetId, { operations: 10, bytes: 1_000 });

    const scheduler = createScheduler<string>({
      clock,
      budget: { ledger, budgetId },
    });
    await scheduler.submit(unit("a", { expectedOutputBytes: 100 }), () => Promise.resolve("a"));

    const report = ledger.report(budgetId);
    expect(report?.dimensions.operations.consumed).toBe(1);
    expect(report?.dimensions.bytes.consumed).toBe(100);
    expect(ledger.openReservationCount()).toBe(0);
  });

  test("a failed unit releases its reservation rather than consuming it", async () => {
    const clock = createManualClock(instant(0));
    const ledger = createBudgetLedger();
    const budgetId = "turn-budget" as BudgetId;
    ledger.createRoot(budgetId, { operations: 10, bytes: 1_000 });

    const scheduler = createScheduler<string>({ clock, budget: { ledger, budgetId } });
    await scheduler.submit(unit("a", { expectedOutputBytes: 100 }), () =>
      Promise.reject(new Error("boom")),
    );

    const report = ledger.report(budgetId);
    expect(report?.dimensions.bytes.consumed).toBe(0);
    expect(report?.dimensions.bytes.reserved).toBe(0);
    expect(ledger.openReservationCount()).toBe(0);
  });
});

describe("cancellation and terminal outcomes", () => {
  test("propagates to both running and queued units", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 1 } });
    const controller = new AbortController();
    const started: string[] = [];

    const pending = scheduler.schedule(
      ["running", "queued"].map((id) => ({
        unit: unit(id),
        run: () => {
          started.push(id);
          return new Promise<string>(() => {});
        },
      })),
      controller.signal,
    );

    await flush();
    expect(started).toEqual(["running"]);

    controller.abort();
    await flush();
    const results = await pending;

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.kind === "settled")).toBe(true);
    for (const result of results) {
      if (result.kind === "settled") {
        expect(result.outcome.kind).toBe("cancelled");
      }
    }
    expect(scheduler.report().running).toBe(0);
    expect(scheduler.report().heldKeys).toEqual([]);
  });

  test("a cancelled unit keeps the evidence it reported", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const controller = new AbortController();

    const pending = scheduler.submit(
      unit("partial"),
      ({ reportPartial }) => {
        reportPartial("half the answer");
        return new Promise<string>(() => {});
      },
      controller.signal,
    );

    await flush();
    controller.abort();
    await flush();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.partial).toBe("half the answer");
      expect(result.outcome.kind).toBe("cancelled");
    }
  });

  test("cancelling a mutation reports an uncertain effect", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const controller = new AbortController();

    const pending = scheduler.submit(
      unit("write", { effect: "mutation" }),
      () => new Promise<string>(() => {}),
      controller.signal,
    );
    await flush();
    controller.abort();
    await flush();
    const result = await pending;

    if (result.kind === "settled") {
      expect(result.outcome).toEqual({ kind: "cancelled", effect: "uncertain" });
    }
  });

  test("cancelling an observation reports no effect", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });
    const controller = new AbortController();

    const pending = scheduler.submit(
      unit("read"),
      () => new Promise<string>(() => {}),
      controller.signal,
    );
    await flush();
    controller.abort();
    await flush();
    const result = await pending;

    if (result.kind === "settled") {
      expect(result.outcome).toEqual({ kind: "cancelled", effect: "none" });
    }
  });

  test("every unit reaches a terminal state", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 2 } });

    const results = await scheduler.schedule([
      { unit: unit("ok"), run: () => Promise.resolve("ok") },
      { unit: unit("boom"), run: () => Promise.reject(new Error("boom")) },
      {
        unit: unit("dependent", { dependencies: [workUnitId("boom")] }),
        run: () => Promise.resolve("x"),
      },
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(["completed", "refused", "settled"]).toContain(result.kind);
    }
    expect(scheduler.report().running).toBe(0);
  });

  test("a deadline produces timed-out, not a silent completion", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });

    const pending = scheduler.submit(
      unit("slow", { deadline: deadlineAt(instant(100)) }),
      () => new Promise<string>(() => {}),
    );
    await clock.runUntilIdle();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.outcome.kind).toBe("timed-out");
    }
  });
});

describe("completion is not inferred from the value", () => {
  test("a unit that legitimately resolves null still completes", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string | null>({ clock });

    const result = await scheduler.submit(unit("producer"), () => Promise.resolve(null));

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.value).toBeNull();
    }
    expect(scheduler.report().completed).toBe(1);
  });

  test("its dependents run rather than being refused", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string | null>({ clock });
    const started: string[] = [];

    const results = await scheduler.schedule([
      {
        unit: unit("producer"),
        run: () => {
          started.push("producer");
          return Promise.resolve(null);
        },
      },
      {
        unit: unit("dependent", { dependencies: [workUnitId("producer")] }),
        run: () => {
          started.push("dependent");
          return Promise.resolve("ok");
        },
      },
    ]);

    expect(started).toEqual(["producer", "dependent"]);
    expect(results.every((result) => result.kind === "completed")).toBe(true);
    expect(scheduler.report().completed).toBe(2);
  });

  test("a unit that resolves undefined completes too", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<void>({ clock });
    const result = await scheduler.submit(unit("void"), () => Promise.resolve());
    expect(result.kind).toBe("completed");
  });
});

describe("scheduler reporting", () => {
  test("a lock timeout names the deadline that was exceeded", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({
      clock,
      limits: { lockAcquisitionTimeoutMs: 50 },
    });
    const key = conflictKey("file", "/repo/a.ts");
    const holder = deferred<string>();

    const pending = scheduler.schedule([
      {
        unit: unit("holder", { effect: "mutation", conflictKeys: [key] }),
        run: () => holder.promise,
      },
      {
        unit: unit("waiter", { effect: "mutation", conflictKeys: [key] }),
        run: () => Promise.resolve("waiter"),
      },
    ]);

    await flush();
    await clock.advance(duration(60));
    await flush();
    holder.resolve("holder");
    const results = await pending;

    const waiter = results.find((result) => result.unitId === ("waiter" as WorkUnitId));
    if (waiter?.kind === "refused" && waiter.error.code === "lock-acquisition-timeout") {
      // Ready at 0, timeout 50 — the reported deadline is 50, not the instant
      // the expiry happened to be noticed.
      expect(waiter.error.deadline).toEqual(deadlineAt(instant(50)));
    } else {
      throw new Error("expected a lock-acquisition-timeout refusal");
    }
  });

  test("counts refusals from every graph-validation path", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock });

    await scheduler.schedule([
      { unit: unit("same"), run: () => Promise.resolve("a") },
      { unit: unit("same"), run: () => Promise.resolve("b") },
    ]);

    expect(scheduler.report().refused).toBe(2);
  });

  test("queue depth covers every live generation, not just the last one", async () => {
    const clock = createManualClock(instant(0));
    const scheduler = createScheduler<string>({ clock, limits: { maxConcurrent: 1 } });
    const gate = deferred<string>();

    const first = scheduler.schedule([
      { unit: unit("running"), run: () => gate.promise },
      { unit: unit("queued-a", { priority: "maintenance" }), run: () => Promise.resolve("a") },
    ]);
    await flush();
    const second = scheduler.schedule([
      { unit: unit("queued-b", { priority: "interactive" }), run: () => Promise.resolve("b") },
    ]);
    await flush();

    const report = scheduler.report();
    expect(report.queued).toBe(2);
    expect(report.queuedByPriority.maintenance).toBe(1);
    expect(report.queuedByPriority.interactive).toBe(1);

    gate.resolve("running");
    await flush(20);
    await Promise.all([first, second]);
    expect(scheduler.report().queued).toBe(0);
  });
});
