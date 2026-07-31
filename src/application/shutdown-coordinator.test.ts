import { describe, expect, test } from "bun:test";

import {
  addDuration,
  createManualClock,
  DEFAULT_PHASE_GRACE_MS,
  duration,
  instant,
  type ManualClock,
  SHUTDOWN_PHASES,
  type ShutdownParticipant,
  type ShutdownPhase,
  type ShutdownPhaseContext,
  type ShutdownReport,
} from "../domain/index.ts";
import { createScopeTree } from "./scope-tree.ts";
import { createShutdownCoordinator } from "./shutdown-coordinator.ts";

function recorder(
  name: string,
  phase: ShutdownPhase,
  log: string[],
  body?: (context: ShutdownPhaseContext) => Promise<void>,
): ShutdownParticipant {
  return {
    name,
    phase,
    async run(context) {
      log.push(name);
      if (body !== undefined) {
        await body(context);
      }
    },
  };
}

/** Never resolves, and never observes its abort signal. The worst-case participant. */
function hangingParticipant(name: string, phase: ShutdownPhase): ShutdownParticipant {
  return { name, phase, run: () => new Promise<void>(() => {}) };
}

async function runToCompletion(
  clock: ManualClock,
  pending: Promise<ShutdownReport>,
): Promise<ShutdownReport> {
  await clock.runUntilIdle();
  return pending;
}

describe("phase order", () => {
  test("matches the canonical sequence", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const report = await runToCompletion(clock, coordinator.shutdown());

    expect(report.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
  });

  test("runs participants in phase order regardless of registration order", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];

    coordinator.register(recorder("late", "restore-terminal", log));
    coordinator.register(recorder("early", "stop-accepting-work", log));
    coordinator.register(recorder("middle", "persist-outcomes", log));

    await runToCompletion(clock, coordinator.shutdown());
    expect(log).toEqual(["early", "middle", "late"]);
  });

  test("a clean shutdown completes with nothing unfinished", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];
    coordinator.register(recorder("drain", "drain-events", log));

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(report.outcome).toEqual({ kind: "completed" });
    expect(report.unfinished).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.phases.every((phase) => phase.status === "completed")).toBe(true);
  });
});

describe("registration", () => {
  test("refuses a participant once shutdown has begun", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const pending = coordinator.shutdown();

    const late = coordinator.register(recorder("late", "drain-events", []));
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.error.code).toBe("shutdown-already-started");
    }
    await runToCompletion(clock, pending);
  });

  test("refuses a duplicate name within a phase", () => {
    const coordinator = createShutdownCoordinator({ clock: createManualClock(instant(0)) });
    expect(coordinator.register(recorder("drain", "drain-events", [])).ok).toBe(true);

    const again = coordinator.register(recorder("drain", "drain-events", []));
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("duplicate-participant");
    }
  });

  test("allows the same name in different phases", () => {
    const coordinator = createShutdownCoordinator({ clock: createManualClock(instant(0)) });
    expect(coordinator.register(recorder("flush", "drain-events", [])).ok).toBe(true);
    expect(coordinator.register(recorder("flush", "close-storage", [])).ok).toBe(true);
    expect(coordinator.registeredParticipants()).toHaveLength(2);
  });
});

describe("deadlines and hanging participants", () => {
  test("a phase ends on its deadline and records what did not finish", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(hangingParticipant("stuck", "drain-events"));

    const report = await runToCompletion(clock, coordinator.shutdown());

    expect(report.unfinished).toEqual(["stuck"]);
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    const drain = report.phases.find((phase) => phase.phase === "drain-events");
    expect(drain?.status).toBe("timed-out");
    expect(drain?.participants).toEqual([{ name: "stuck", status: "timed-out", failure: null }]);
  });

  test("the phase deadline is the declared grace, measured on the clock", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(hangingParticipant("stuck", "stop-accepting-work"));

    const report = await runToCompletion(clock, coordinator.shutdown());
    const phase = report.phases[0];
    expect(phase?.endedAt).toBe(instant(DEFAULT_PHASE_GRACE_MS));
  });

  test("a hanging participant does not stop later phases", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];

    coordinator.register(hangingParticipant("stuck", "drain-events"));
    coordinator.register(recorder("later", "close-storage", log));

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(log).toEqual(["later"]);
    expect(report.unfinished).toEqual(["stuck"]);
  });

  test("a participant is told the phase ended through its abort signal", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const observed: string[] = [];

    coordinator.register({
      name: "cooperative",
      phase: "drain-events",
      async run(context) {
        // Waits well past its own phase, so only the abort can release it.
        observed.push(
          await context.clock.waitUntil(
            addDuration(context.deadline.expiresAt, duration(60_000)),
            context.signal,
          ),
        );
      },
    });

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(observed).toEqual(["aborted"]);
    expect(report.unfinished).toEqual(["cooperative"]);
  });
});

describe("failures", () => {
  test("are aggregated rather than dropped", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });

    coordinator.register({
      name: "first",
      phase: "drain-events",
      run: () => Promise.reject(new Error("drain failed")),
    });
    coordinator.register({
      name: "second",
      phase: "close-storage",
      run: () => Promise.reject(new Error("close failed")),
    });

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(report.failures.map((failure) => failure.name)).toEqual(["first", "second"]);
    expect(report.failures.map((failure) => failure.failure)).toEqual([
      "drain failed",
      "close failed",
    ]);
    expect(report.outcome).toEqual({ kind: "failed", effect: "partial" });
  });

  test("a failing participant does not stop its own phase", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];

    coordinator.register({
      name: "broken",
      phase: "drain-events",
      run: () => Promise.reject(new Error("boom")),
    });
    coordinator.register(recorder("healthy", "drain-events", log));

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(log).toEqual(["healthy"]);
    expect(report.phases.find((phase) => phase.phase === "drain-events")?.status).toBe("completed");
  });

  test("a non-error throw is still reported safely", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register({
      name: "odd",
      phase: "drain-events",
      run: () => Promise.reject("a bare string"),
    });

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(report.failures[0]?.failure).toBe("non-error value thrown");
  });

  test("a long failure message is truncated before it reaches the report", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register({
      name: "verbose",
      phase: "drain-events",
      run: () => Promise.reject(new Error("x".repeat(5_000))),
    });

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(report.failures[0]?.failure?.length).toBeLessThanOrEqual(201);
  });

  test("both a failure and an unfinished participant make the outcome uncertain", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register({
      name: "broken",
      phase: "drain-events",
      run: () => Promise.reject(new Error("boom")),
    });
    coordinator.register(hangingParticipant("stuck", "close-storage"));

    const report = await runToCompletion(clock, coordinator.shutdown());
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    expect(report.failures).toHaveLength(1);
  });
});

describe("escalation", () => {
  test("shortens the remaining grace without skipping a phase", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.register(hangingParticipant("stuck", "stop-accepting-work"));

    const pending = coordinator.shutdown();
    await clock.advance(duration(10));
    coordinator.escalate("forced");

    const report = await runToCompletion(clock, pending);
    expect(report.level).toBe("forced");
    expect(report.phases.map((phase) => phase.phase)).toEqual([...SHUTDOWN_PHASES]);
    expect(report.phases[0]?.endedAt).toBeLessThan(instant(DEFAULT_PHASE_GRACE_MS));
  });

  test("never lowers the level", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    coordinator.escalate("forced");
    coordinator.escalate("graceful");
    expect(coordinator.level()).toBe("forced");
    await runToCompletion(clock, coordinator.shutdown());
  });

  test("a forced shutdown still runs every phase", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];
    for (const phase of SHUTDOWN_PHASES) {
      coordinator.register(recorder(phase, phase, log));
    }

    const report = await runToCompletion(clock, coordinator.shutdown({ level: "forced" }));
    expect(log).toEqual([...SHUTDOWN_PHASES]);
    expect(report.outcome).toEqual({ kind: "completed" });
  });
});

describe("idempotency and scope integration", () => {
  test("a second shutdown returns the same sequence", async () => {
    const clock = createManualClock(instant(0));
    const coordinator = createShutdownCoordinator({ clock });
    const log: string[] = [];
    coordinator.register(recorder("drain", "drain-events", log));

    const first = coordinator.shutdown();
    const second = coordinator.shutdown();
    expect(first).toBe(second);

    const report = await runToCompletion(clock, first);
    expect(log).toEqual(["drain"]);
    expect(report.phases).toHaveLength(SHUTDOWN_PHASES.length);
  });

  test("cancels the root scope during its phase", async () => {
    const clock = createManualClock(instant(0));
    const scopeTree = createScopeTree({ clock });
    const coordinator = createShutdownCoordinator({ clock, scopeTree });
    const observed: string[] = [];

    coordinator.register({
      name: "observer",
      phase: "cancel-root-scope",
      async run() {
        observed.push(scopeTree.state(scopeTree.root().scopeId)?.status ?? "missing");
      },
    });

    await runToCompletion(clock, coordinator.shutdown());
    expect(observed).toEqual(["cancelling"]);
  });

  test("leaves no scope in a non-terminal state", async () => {
    const clock = createManualClock(instant(0));
    const scopeTree = createScopeTree({ clock });
    const coordinator = createShutdownCoordinator({ clock, scopeTree });

    const turn = scopeTree.derive(scopeTree.root().scopeId, { kind: "turn" });
    if (!turn.ok) {
      throw new Error("derive failed");
    }

    await runToCompletion(clock, coordinator.shutdown());
    expect(scopeTree.liveScopeCount()).toBe(0);
    expect(scopeTree.state(turn.value.scopeId)).toMatchObject({
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
  });

  test("does not convert an unknown result into success", async () => {
    const clock = createManualClock(instant(0));
    const scopeTree = createScopeTree({ clock });
    const coordinator = createShutdownCoordinator({ clock, scopeTree });

    const invocation = scopeTree.derive(scopeTree.root().scopeId, { kind: "invocation" });
    if (!invocation.ok) {
      throw new Error("derive failed");
    }
    scopeTree.recordEffect(invocation.value.scopeId, "partial");

    await runToCompletion(clock, coordinator.shutdown({ level: "forced" }));
    const report = scopeTree.report(invocation.value.scopeId);
    expect(report?.state).toMatchObject({ outcome: { kind: "uncertain", effect: "uncertain" } });
    expect(report?.requiresInspection).toBe(true);
  });

  test("a scope that acknowledged is left as it settled", async () => {
    const clock = createManualClock(instant(0));
    const scopeTree = createScopeTree({ clock });
    const coordinator = createShutdownCoordinator({ clock, scopeTree });

    const turn = scopeTree.derive(scopeTree.root().scopeId, { kind: "turn" });
    if (!turn.ok) {
      throw new Error("derive failed");
    }
    scopeTree.complete(turn.value.scopeId);

    await runToCompletion(clock, coordinator.shutdown());
    expect(scopeTree.state(turn.value.scopeId)).toMatchObject({
      outcome: { kind: "completed" },
    });
  });
});
