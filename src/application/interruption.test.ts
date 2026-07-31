import { describe, expect, test } from "bun:test";

import { createManualClock, createManualSignalPort, duration, instant } from "../domain/index.ts";
import {
  attachInterruptionPolicy,
  createInterruptionPolicy,
  type InterruptionDecision,
} from "./interruption.ts";

describe("interruption escalation", () => {
  test("the first interrupt only requests cooperative cancellation", () => {
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    expect(policy.interrupt("interrupt")).toEqual({
      action: "request-cancellation",
      level: "graceful",
    });
    expect(policy.state().level).toBe("graceful");
  });

  test("repeated interrupts escalate through the documented ladder", () => {
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    const actions = [
      policy.interrupt("interrupt"),
      policy.interrupt("interrupt"),
      policy.interrupt("interrupt"),
      policy.interrupt("interrupt"),
    ].map((decision) => decision.action);

    expect(actions).toEqual(["request-cancellation", "escalate", "force", "ignored"]);
  });

  test("the level never goes back down", () => {
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    policy.interrupt("interrupt");
    policy.interrupt("interrupt");
    policy.interrupt("interrupt");
    policy.interrupt("terminate");
    expect(policy.state().level).toBe("forced");
  });

  test("records when the first and latest interrupts arrived", async () => {
    const clock = createManualClock(instant(0));
    const policy = createInterruptionPolicy(clock);

    policy.interrupt("interrupt");
    await clock.advance(duration(750));
    policy.interrupt("terminate");

    const state = policy.state();
    expect(state.firstAt).toBe(instant(0));
    expect(state.lastAt).toBe(instant(750));
    expect(state.lastSignal).toBe("terminate");
    expect(state.count).toBe(2);
  });

  test("counts every interrupt, including rapid repeats", () => {
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    for (let index = 0; index < 5; index += 1) {
      policy.interrupt("interrupt");
    }
    expect(policy.state().count).toBe(5);
  });

  test("reports no interrupt before one arrives", () => {
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    expect(policy.state()).toEqual({
      level: "graceful",
      count: 0,
      firstAt: null,
      lastAt: null,
      lastSignal: null,
    });
  });
});

describe("attaching a signal port", () => {
  test("routes each host signal through the policy", () => {
    const port = createManualSignalPort();
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    const decisions: InterruptionDecision[] = [];

    attachInterruptionPolicy(port, policy, (decision) => decisions.push(decision));
    port.emit("interrupt");
    port.emit("terminate");

    expect(decisions.map((decision) => decision.action)).toEqual([
      "request-cancellation",
      "escalate",
    ]);
  });

  test("passes the originating signal alongside the decision", () => {
    const port = createManualSignalPort();
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    const seen: string[] = [];

    attachInterruptionPolicy(port, policy, (_decision, signal) => seen.push(signal));
    port.emit("hangup");
    expect(seen).toEqual(["hangup"]);
  });

  test("releasing the subscription stops delivery", () => {
    const port = createManualSignalPort();
    const policy = createInterruptionPolicy(createManualClock(instant(0)));
    const decisions: InterruptionDecision[] = [];

    const release = attachInterruptionPolicy(port, policy, (decision) => decisions.push(decision));
    release();
    port.emit("interrupt");

    expect(decisions).toEqual([]);
    expect(port.subscriberCount()).toBe(0);
    expect(policy.state().count).toBe(0);
  });
});
