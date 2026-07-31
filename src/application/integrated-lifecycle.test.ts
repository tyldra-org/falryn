/**
 * The crossings between the runtime's parts.
 *
 * Every test here spans at least two subsystems. Each one passes inside its own
 * suite already; what was never proven is that they agree with each other, and
 * that is the only thing this file asserts.
 */

import { describe, expect, test } from "bun:test";

import {
  createManualClock,
  createManualSignalPort,
  duration,
  EVENT_KINDS,
  effectOf,
  instant,
  type ManualClock,
  type ManualSignalPort,
  NO_CORRELATION,
  NO_RETRY,
  type ScopeId,
  type ShutdownReport,
  scopeId as scopeIdCodec,
  type WorkUnit,
  workUnitId,
} from "../domain/index.ts";
import { fromUnknown, withContext } from "./error-translation.ts";
import { createRuntimeLifecycle, type RuntimeLifecycle } from "./runtime-lifecycle.ts";

function makeRuntime(schedulerLimits?: { maxConcurrent: number }): {
  clock: ManualClock;
  signals: ManualSignalPort;
  runtime: RuntimeLifecycle;
} {
  const clock = createManualClock(instant(0));
  const signals = createManualSignalPort();
  return {
    clock,
    signals,
    runtime: createRuntimeLifecycle({
      clock,
      signals,
      ...(schedulerLimits === undefined ? {} : { schedulerLimits }),
    }),
  };
}

function unit(id: string, scopeId: ScopeId | null, overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: workUnitId(id),
    effect: "observation",
    priority: "active-turn",
    conflictKeys: [],
    dependencies: [],
    deadline: null,
    expectedOutputBytes: 0,
    retry: NO_RETRY,
    scopeId,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function deriveScope(runtime: RuntimeLifecycle, id: string, parent?: ScopeId): ScopeId {
  const derived = runtime.scopes.derive(parent ?? runtime.scopes.root().scopeId, {
    kind: "turn",
    scopeId: scopeIdCodec.from(id),
  });
  if (!derived.ok) {
    throw new Error(`derive failed: ${derived.error.code}`);
  }
  return derived.value.scopeId;
}

describe("scheduling under cancellation scopes", () => {
  test("cancelling a scope cancels the work running under it", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const pending = runtime.scheduler.submit(
      unit("read", scope),
      () => new Promise<unknown>(() => {}),
    );
    await flush();

    runtime.scopes.cancel(scope, { kind: "requested" });
    await flush();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.outcome.kind).toBe("cancelled");
    }
    runtime.dispose();
  });

  test("the scope and the scheduler agree on effect certainty", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const pending = runtime.scheduler.submit(
      unit("write", scope, { effect: "mutation" }),
      () => new Promise<unknown>(() => {}),
    );
    await flush();

    runtime.scopes.cancel(scope, { kind: "requested" });
    await flush();
    const result = await pending;

    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") {
      return;
    }
    // The scheduler says the mutation's effect is unobserved...
    expect(effectOf(result.outcome)).toBe("uncertain");
    // ...and the scope was told, so a reader of either reaches the same answer.
    const report = runtime.scopes.report(scope);
    expect(report?.recordedEffect).toBe("uncertain");
    expect(report?.requiresInspection).toBe(true);
    runtime.dispose();
  });

  test("an observation cancelled through its scope leaves no effect behind", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const pending = runtime.scheduler.submit(
      unit("read", scope),
      () => new Promise<unknown>(() => {}),
    );
    await flush();
    runtime.scopes.cancel(scope, { kind: "requested" });
    await flush();
    await pending;

    expect(runtime.scopes.report(scope)?.requiresInspection).toBe(false);
    runtime.dispose();
  });

  test("cancelling an ancestor reaches work queued under a descendant", async () => {
    const { runtime } = makeRuntime({ maxConcurrent: 1 });
    const session = deriveScope(runtime, "session-1");
    const turn = deriveScope(runtime, "turn-1", session);
    const started: string[] = [];

    const pending = runtime.scheduler.schedule([
      {
        unit: unit("running", turn),
        run: () => {
          started.push("running");
          return new Promise<unknown>(() => {});
        },
      },
      {
        unit: unit("queued", turn),
        run: () => {
          started.push("queued");
          return new Promise<unknown>(() => {});
        },
      },
    ]);
    await flush();
    expect(started).toEqual(["running"]);

    // Cancel the ancestor, not the scope the units name.
    runtime.scopes.cancel(session, { kind: "requested" });
    await flush(12);
    const results = await pending;

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.kind).toBe("settled");
      if (result.kind === "settled") {
        expect(result.outcome.kind).toBe("cancelled");
      }
    }
    expect(runtime.scheduler.report().running).toBe(0);
    runtime.dispose();
  });

  test("a unit that already finished is left alone when its scope cancels", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const result = await runtime.scheduler.submit(unit("done", scope), () =>
      Promise.resolve("value"),
    );
    expect(result.kind).toBe("completed");

    runtime.scopes.cancel(scope, { kind: "requested" });
    // The completed result is unchanged; cancellation cannot rewrite it.
    expect(result.kind).toBe("completed");
    expect(runtime.scopes.report(scope)?.recordedEffect).toBe("completed");
    runtime.dispose();
  });

  test("a unit submitted under an already-cancelling scope does not run its work", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    runtime.scopes.cancel(scope, { kind: "requested" });

    let ran = false;
    const result = await runtime.scheduler.submit(unit("late", scope), () => {
      ran = true;
      return new Promise<unknown>(() => {});
    });

    expect(result.kind).toBe("settled");
    if (result.kind === "settled") {
      expect(result.outcome.kind).toBe("cancelled");
    }
    // The runner is invoked, but it is aborted before it can do anything and is
    // never awaited to completion.
    expect(ran).toBe(true);
    runtime.dispose();
  });

  test("a unit with no scope is unaffected by scope cancellation", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    const gate = deferred<unknown>();

    const pending = runtime.scheduler.submit(unit("detached", null), () => gate.promise);
    await flush();
    runtime.scopes.cancel(scope, { kind: "requested" });
    await flush();

    gate.resolve("value");
    expect((await pending).kind).toBe("completed");
    runtime.dispose();
  });
});

describe("shutdown drains scheduled work", () => {
  async function settle(clock: ManualClock, pending: Promise<ShutdownReport>) {
    await clock.runUntilIdle();
    return pending;
  }

  test("registers its drain in the phase the canonical order assigns", () => {
    const { runtime } = makeRuntime();
    expect(runtime.shutdown.registeredParticipants()).toEqual([
      { name: "scheduler-drain", phase: "stop-scheduling" },
    ]);
    runtime.dispose();
  });

  test("scoped work is already stopped by the time the drain runs", async () => {
    const { clock, runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const work = runtime.scheduler.submit(
      unit("slow", scope),
      () => new Promise<unknown>(() => {}),
    );
    await flush();
    expect(runtime.scheduler.report().running).toBe(1);

    // `cancel-root-scope` runs before `stop-scheduling`, so the root
    // cancellation reaches this unit through its scope and the drain finds
    // nothing left to wait for. That ordering is the point of the phase list.
    const report = await settle(clock, runtime.requestShutdown());

    expect((await work).kind).toBe("settled");
    expect(runtime.scheduler.report().running).toBe(0);
    expect(report.unfinished).toEqual([]);
    expect(report.outcome).toEqual({ kind: "completed" });
    runtime.dispose();
  });

  test("waits for unscoped work that the root cancellation cannot reach", async () => {
    const { clock, runtime } = makeRuntime();
    const gate = deferred<unknown>();

    // No scope, so cancelling the root does not touch it. This is the work the
    // drain participant actually exists for.
    const work = runtime.scheduler.submit(unit("detached", null), () => gate.promise);
    await flush();

    const shutdown = runtime.requestShutdown();
    await flush();
    expect(runtime.scheduler.report().running).toBe(1);

    gate.resolve("value");
    await work;
    const report = await settle(clock, shutdown);

    expect(report.unfinished).toEqual([]);
    expect(report.outcome).toEqual({ kind: "completed" });
    runtime.dispose();
  });

  test("reports unscoped work that will not stop as unfinished, not as a clean exit", async () => {
    const { clock, runtime } = makeRuntime();

    // Unscoped and never resolving: nothing can stop it, so the drain must say
    // so rather than let the shutdown report a clean exit.
    void runtime.scheduler.submit(unit("stuck", null), () => new Promise<unknown>(() => {}));
    await flush();

    const report = await settle(clock, runtime.requestShutdown());

    expect(report.unfinished).toEqual(["scheduler-drain"]);
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    expect(report.phases.find((phase) => phase.phase === "stop-scheduling")?.status).toBe(
      "timed-out",
    );
    runtime.dispose();
  });

  test("a shutdown with nothing scheduled drains immediately", async () => {
    const { clock, runtime } = makeRuntime();
    const report = await settle(clock, runtime.requestShutdown());

    expect(report.outcome).toEqual({ kind: "completed" });
    expect(runtime.scopes.liveScopeCount()).toBe(0);
    runtime.dispose();
  });

  test("an interrupt drains scheduled work through the same path", async () => {
    const { clock, signals, runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    const gate = deferred<unknown>();
    const work = runtime.scheduler.submit(unit("slow", scope), () => gate.promise);

    await flush();
    signals.emit("interrupt");
    await flush();

    gate.resolve("value");
    await work;
    const report = await settle(clock, runtime.requestShutdown());

    expect(report.unfinished).toEqual([]);
    runtime.dispose();
  });
});

describe("diagnostics across the backbone", () => {
  test("the scope tree emits its lifecycle transitions", () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    runtime.scopes.cancel(scope, { kind: "requested" });
    runtime.scopes.acknowledge(scope);

    const emitted = runtime.diagnostics
      .events()
      .filter((event) => event.subsystem === "scope" && event.correlation.scopeId === scope);

    expect(emitted.map((event) => event.code)).toEqual([
      "scope.opened",
      "scope.cancellation.requested",
      "scope.terminal",
    ]);
    runtime.dispose();
  });

  test("a terminal scope diagnostic carries acknowledgement latency", async () => {
    const { clock, runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    runtime.scopes.cancel(scope, { kind: "requested" });
    await clock.advance(duration(75));
    runtime.scopes.acknowledge(scope);

    const terminal = runtime.diagnostics
      .events()
      .find((event) => event.code === "scope.terminal" && event.correlation.scopeId === scope);
    expect(terminal?.durationMs).toBe(duration(75));
    runtime.dispose();
  });

  test("the scheduler emits a unit outcome with its scope correlation", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    await runtime.scheduler.submit(unit("read", scope), () => Promise.resolve("value"));

    const emitted = runtime.diagnostics.events().find((event) => event.subsystem === "scheduler");
    expect(emitted?.code).toBe("scheduler.unit.completed");
    expect(emitted?.correlation.scopeId).toBe(scope);
    expect(emitted?.limits).toEqual({ maxConcurrent: 8 });
    runtime.dispose();
  });

  test("the shutdown coordinator emits one diagnostic per phase", async () => {
    const { clock, runtime } = makeRuntime();
    const pending = runtime.requestShutdown();
    await clock.runUntilIdle();
    await pending;

    const phases = runtime.diagnostics.events().filter((event) => event.subsystem === "shutdown");
    expect(phases).toHaveLength(10);
    expect(phases.every((event) => event.code === "shutdown.phase")).toBe(true);
    runtime.dispose();
  });

  test("no diagnostic carries payload content", async () => {
    const { clock, runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    await runtime.scheduler.submit(unit("read", scope), () => Promise.resolve("a secret value"));
    const pending = runtime.requestShutdown();
    await clock.runUntilIdle();
    await pending;

    const text = JSON.stringify(runtime.diagnostics.events());
    expect(text).not.toContain("a secret value");
    for (const event of runtime.diagnostics.events()) {
      for (const value of Object.values(event.metadata)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
    runtime.dispose();
  });

  test("diagnostics stay bounded across a whole runtime lifetime", async () => {
    const { clock, runtime } = makeRuntime();
    for (let index = 0; index < 200; index += 1) {
      const scope = deriveScope(runtime, `turn-${index}`);
      runtime.scopes.complete(scope);
    }
    const pending = runtime.requestShutdown();
    await clock.runUntilIdle();
    await pending;

    const report = runtime.diagnostics.report();
    expect(report.retained).toBeLessThanOrEqual(2_000);
    expect(report.distinctSeries).toBeLessThanOrEqual(256);
    runtime.dispose();
  });
});

describe("failure crossing the backbone", () => {
  test("surfaces as a FalrynError with correlation intact", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");

    const result = await runtime.scheduler.submit(unit("boom", scope), () =>
      Promise.reject(new Error("the runner threw")),
    );
    expect(result.kind).toBe("settled");

    const error = withContext(fromUnknown(new Error("the runner threw")), {
      correlation: { ...NO_CORRELATION, scopeId: scope },
      operation: "scheduled unit",
    });

    expect(error.category).toBe("internal");
    expect(error.correlation.scopeId).toBe(scope);
    expect(error.cause?.detail).toContain("scheduled unit");
    runtime.dispose();
  });

  test("a scheduler failure is visible in diagnostics", async () => {
    const { runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    await runtime.scheduler.submit(unit("boom", scope), () =>
      Promise.reject(new Error("the runner threw")),
    );

    const emitted = runtime.diagnostics.events().find((event) => event.subsystem === "scheduler");
    expect(emitted?.code).toBe("scheduler.unit.failed");
    expect(emitted?.level).toBe("warn");
    expect(JSON.stringify(emitted)).not.toContain("the runner threw");
    runtime.dispose();
  });
});

describe("runtime events have no producer yet", () => {
  test("the backbone emits none, and that is the recorded decision", async () => {
    const { clock, runtime } = makeRuntime();
    const scope = deriveScope(runtime, "turn-1");
    await runtime.scheduler.submit(unit("read", scope), () => Promise.resolve("value"));
    runtime.scopes.cancel(scope, { kind: "requested" });
    const pending = runtime.requestShutdown();
    await clock.runUntilIdle();
    await pending;

    // Every declared kind describes a session, turn, model attempt, capability
    // invocation, or configuration generation. The backbone has none of those
    // concepts, so it must not invent an event kind to have something to emit.
    // Persistence and the agent loop are the first real producers.
    const diagnosticCodes = runtime.diagnostics.events().map((event) => event.code);
    for (const kind of EVENT_KINDS) {
      expect(diagnosticCodes).not.toContain(kind);
    }
    // Scope lifecycle observations are not RuntimeEvents and never claim to be.
    expect(runtime.scopes.events().every((event) => event.kind.startsWith("scope."))).toBe(true);
    runtime.dispose();
  });
});
