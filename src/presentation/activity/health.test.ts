/**
 * The runtime's health, as one value.
 *
 * The property under test is the *precedence*, not the arithmetic. A run with
 * three completed scopes and one uncertain effect is not "mostly fine": the
 * uncertain effect is the thing someone has to act on, and any rule that
 * averaged would bury it. Every test here is about which fact wins.
 */

import { describe, expect, test } from "bun:test";
import type { QueueReport, SchedulerReport } from "../../domain/index.ts";
import { everyOutcome, running, settled } from "./fixtures.ts";
import { HEALTH_LEVELS, type HealthInput, NO_HEALTH_INPUT, projectHealth } from "./health.ts";
import { EMPTY_ACTIVITY, reduceActivity } from "./reducer.ts";

function withEvents(events: Parameters<typeof reduceActivity>[1]): HealthInput {
  return { ...NO_HEALTH_INPUT, activity: reduceActivity(EMPTY_ACTIVITY, events) };
}

const NO_SCHEDULING: SchedulerReport = {
  running: 0,
  queued: 0,
  queuedByPriority: {
    "active-turn": 0,
    interactive: 0,
    maintenance: 0,
    "user-visible-background": 0,
  },
  heldKeys: [],
  completed: 0,
  refused: 0,
  settledNonCompleted: 0,
  promotions: 0,
};

const EMPTY_QUEUE: QueueReport = {
  items: 0,
  bytes: 0,
  maxItems: 100,
  maxBytes: 1_000,
  waiting: 0,
  accepted: 0,
  coalesced: 0,
  spilled: 0,
  rejected: 0,
  expired: 0,
};

describe("nothing attached", () => {
  test("is unknown rather than healthy", () => {
    // The difference `FactValue` draws between `empty` and `unavailable`.
    // Nothing is running and nothing can tell us are not the same answer, and a
    // green tick for the second would be reporting success by omission.
    const health = projectHealth(NO_HEALTH_INPUT);
    expect(health.level).toBe("unknown");
    expect(health.headline).toContain("No runtime is attached");
  });

  test("is idle once something is reporting, even with nothing to report", () => {
    const health = projectHealth({ ...NO_HEALTH_INPUT, scheduler: NO_SCHEDULING });
    expect(health.level).toBe("idle");
    expect(health.headline).toBe("Nothing is running.");
  });
});

describe("precedence", () => {
  test("shutting down outranks everything, including live work", () => {
    // The only state where what a user should do changes completely. A rail
    // showing "busy" while the process tears down describes work being
    // cancelled as work progressing.
    const health = projectHealth({
      ...withEvents(running(0, "live")),
      shutdown: { shuttingDown: true, level: "graceful" },
    });
    expect(health.level).toBe("failing");
    expect(health.headline).toContain("Shutting down");
  });

  test("an unconfirmed effect outranks a failure", () => {
    // Both need someone to look; uncertain needs it more, because nobody has.
    const health = projectHealth(
      withEvents([
        ...settled(0, "failed", { kind: "failed", effect: "none" }),
        ...settled(2, "unknown", { kind: "uncertain", effect: "uncertain" }),
      ]),
    );
    expect(health.level).toBe("failing");
    expect(health.headline).toContain("unconfirmed effect");
  });

  test("counts a settled outcome with an unobserved effect as uncertain", () => {
    // A cancelled operation that may have changed something outside Falryn is
    // the same problem for a reader as an uncertain outcome.
    const health = projectHealth(
      withEvents(settled(0, "cancelled", { kind: "cancelled", effect: "uncertain" })),
    );
    expect(health.level).toBe("failing");
  });

  test("a failure outranks a refusal", () => {
    const health = projectHealth({
      ...withEvents(settled(0, "failed", { kind: "failed", effect: "none" })),
      scheduler: { ...NO_SCHEDULING, refused: 3 },
    });
    expect(health.level).toBe("failing");
    expect(health.headline).toContain("failed");
  });

  test("a refusal is degraded rather than failing", () => {
    // Something was asked for and did not happen, which is a different thing
    // from something that failed.
    const health = projectHealth({
      ...NO_HEALTH_INPUT,
      scheduler: { ...NO_SCHEDULING, refused: 1 },
    });
    expect(health.level).toBe("degraded");
    expect(health.headline).toContain("was not accepted");
  });

  test("expired queue items are degraded and never silent", () => {
    const health = projectHealth({ ...NO_HEALTH_INPUT, queue: { ...EMPTY_QUEUE, expired: 2 } });
    expect(health.level).toBe("degraded");
  });

  test("a cancellation is degraded rather than failing", () => {
    // Cancellation is control flow, not an error — the runtime's own position.
    const health = projectHealth(
      withEvents(settled(0, "stopped", { kind: "cancelled", effect: "none" })),
    );
    expect(health.level).toBe("degraded");
    expect(health.headline).toContain("cancelled");
  });

  test("live work is busy when nothing worse is true", () => {
    const health = projectHealth(withEvents(running(0, "live")));
    expect(health.level).toBe("busy");
    expect(health.headline).toBe("1 operation running.");
  });

  test("settled work alone with no trouble is idle", () => {
    const health = projectHealth(withEvents(settled(0, "done", { kind: "completed" })));
    expect(health.level).toBe("idle");
  });
});

describe("the facts", () => {
  test("shows nothing when there is nothing to show", () => {
    // A status line listing eleven zeroed counters is a telemetry dump, and the
    // design direction refuses one.
    expect(projectHealth(NO_HEALTH_INPUT).facts).toEqual([]);
    expect(projectHealth({ ...NO_HEALTH_INPUT, scheduler: NO_SCHEDULING }).facts).toEqual([]);
  });

  test("reports running, queued, buffered, and waiting when non-zero", () => {
    const health = projectHealth({
      ...withEvents(running(0, "live")),
      scheduler: { ...NO_SCHEDULING, queued: 2 },
      queue: { ...EMPTY_QUEUE, items: 5, waiting: 1 },
    });
    const labels = health.facts.map((fact) => fact.label);
    expect(labels).toEqual(["running", "queued", "buffered", "waiting"]);
  });

  test("names what the projection dropped rather than hiding it", () => {
    const health = projectHealth({
      ...NO_HEALTH_INPUT,
      activity: { ...EMPTY_ACTIVITY, droppedSettled: 7 },
    });
    expect(health.facts).toContainEqual({ label: "not shown", value: "7 finished" });
  });
});

describe("every outcome the runtime owns", () => {
  test("is reachable and none of them reads as success", () => {
    // The acceptance criterion, from the health side. A corpus containing every
    // terminal outcome must not resolve to idle: two of them need attention and
    // one of those needs it urgently.
    const health = projectHealth(withEvents(everyOutcome()));
    expect(health.level).toBe("failing");
  });

  test("declares its levels worst-first, so a precedence reads in order", () => {
    expect(HEALTH_LEVELS[0]).toBe("failing");
    expect(HEALTH_LEVELS.at(-1)).toBe("unknown");
  });
});
