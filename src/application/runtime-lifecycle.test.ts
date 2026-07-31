import { describe, expect, test } from "bun:test";

import {
  createManualClock,
  createManualSignalPort,
  duration,
  instant,
  type ManualClock,
  type ManualSignalPort,
  SHUTDOWN_PHASES,
  type ShutdownReport,
} from "../domain/index.ts";
import { createRuntimeLifecycle, type RuntimeLifecycle } from "./runtime-lifecycle.ts";

function makeLifecycle(): {
  clock: ManualClock;
  signals: ManualSignalPort;
  lifecycle: RuntimeLifecycle;
} {
  const clock = createManualClock(instant(0));
  const signals = createManualSignalPort();
  return { clock, signals, lifecycle: createRuntimeLifecycle({ clock, signals }) };
}

async function settle(clock: ManualClock, pending: Promise<ShutdownReport>) {
  await clock.runUntilIdle();
  return pending;
}

describe("composition", () => {
  test("opens a root application scope and a matching context", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.scopes.root().kind).toBe("application");
    expect(lifecycle.rootContext.scopeId).toBe(lifecycle.scopes.root().scopeId);
    expect(lifecycle.rootContext.cancellation.aborted).toBe(false);
    lifecycle.dispose();
  });

  test("subscribes to the host signal port and releases it on dispose", () => {
    const { signals, lifecycle } = makeLifecycle();
    expect(signals.subscriberCount()).toBe(1);
    lifecycle.dispose();
    expect(signals.subscriberCount()).toBe(0);
  });

  test("disposing twice is safe", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.dispose();
    lifecycle.dispose();
  });
});

describe("interrupt handling", () => {
  test("the first interrupt cancels the root scope and begins shutdown", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();

    signals.emit("interrupt");
    expect(lifecycle.scopes.state(lifecycle.scopes.root().scopeId)?.status).toBe("cancelling");
    expect(lifecycle.shutdown.isShuttingDown()).toBe(true);
    expect(lifecycle.shutdown.level()).toBe("graceful");

    const report = await settle(clock, lifecycle.requestShutdown());
    expect(report.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
    lifecycle.dispose();
  });

  test("an interrupt arriving while shutdown is draining escalates it", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();
    lifecycle.shutdown.register({
      name: "slow-drain",
      phase: "drain-events",
      run: () => new Promise<void>(() => {}),
    });

    signals.emit("interrupt");
    await clock.advance(duration(1));
    expect(lifecycle.shutdown.level()).toBe("graceful");

    signals.emit("interrupt");
    expect(lifecycle.shutdown.level()).toBe("escalated");

    const report = await settle(clock, lifecycle.requestShutdown());
    expect(report.level).toBe("escalated");
    expect(report.unfinished).toEqual(["slow-drain"]);
    lifecycle.dispose();
  });

  test("a third interrupt forces, and a fourth changes nothing", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();

    signals.emit("interrupt");
    signals.emit("interrupt");
    signals.emit("interrupt");
    signals.emit("interrupt");

    expect(lifecycle.shutdown.level()).toBe("forced");
    expect(lifecycle.interruptions().map((entry) => entry.decision.action)).toEqual([
      "request-cancellation",
      "escalate",
      "force",
      "ignored",
    ]);

    await settle(clock, lifecycle.requestShutdown());
    lifecycle.dispose();
  });

  test("repeated interrupts never start a second shutdown sequence", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();
    const log: string[] = [];
    lifecycle.shutdown.register({
      name: "drain",
      phase: "drain-events",
      async run() {
        log.push("drain");
      },
    });

    signals.emit("interrupt");
    signals.emit("interrupt");
    signals.emit("interrupt");

    await settle(clock, lifecycle.requestShutdown());
    expect(log).toEqual(["drain"]);
    lifecycle.dispose();
  });

  test("forcing still runs every phase and reports what was not observed", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();
    lifecycle.shutdown.register({
      name: "stuck",
      phase: "terminate-children",
      run: () => new Promise<void>(() => {}),
    });

    const turn = lifecycle.scopes.derive(lifecycle.scopes.root().scopeId, { kind: "turn" });
    if (!turn.ok) {
      throw new Error("derive failed");
    }

    signals.emit("interrupt");
    signals.emit("interrupt");
    signals.emit("interrupt");

    const report = await settle(clock, lifecycle.requestShutdown());
    expect(report.level).toBe("forced");
    expect(report.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    expect(lifecycle.scopes.liveScopeCount()).toBe(0);
    expect(lifecycle.scopes.state(turn.value.scopeId)).toMatchObject({
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
    lifecycle.dispose();
  });

  test("a disposed lifecycle ignores later signals", async () => {
    const { clock, signals, lifecycle } = makeLifecycle();
    lifecycle.dispose();
    signals.emit("interrupt");

    expect(lifecycle.shutdown.isShuttingDown()).toBe(false);
    expect(lifecycle.interruptions()).toEqual([]);
    await settle(clock, lifecycle.requestShutdown());
  });
});

describe("direct shutdown", () => {
  test("requesting shutdown twice returns the same sequence", async () => {
    const { clock, lifecycle } = makeLifecycle();
    const first = lifecycle.requestShutdown();
    const second = lifecycle.requestShutdown();
    expect(first).toBe(second);

    const report = await settle(clock, first);
    expect(report.outcome).toEqual({ kind: "completed" });
    lifecycle.dispose();
  });

  test("a clean shutdown leaves nothing non-terminal", async () => {
    const { clock, lifecycle } = makeLifecycle();
    const report = await settle(clock, lifecycle.requestShutdown());

    expect(report.outcome).toEqual({ kind: "completed" });
    expect(lifecycle.scopes.liveScopeCount()).toBe(0);
    lifecycle.dispose();
  });
});
