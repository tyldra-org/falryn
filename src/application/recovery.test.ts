import { describe, expect, test } from "bun:test";

import {
  backoffDelayMs,
  createManualClock,
  DEFAULT_RETRY_BACKOFF,
  duration,
  evaluateRetry,
  type FalrynError,
  instant,
  NO_CORRELATION,
  RECOVERY_ACTIONS,
  type RetryRequest,
} from "../domain/index.ts";
import {
  awaitBackoff,
  describeRecovery,
  planRecovery,
  recoveryPlan,
  requiresObservationFirst,
} from "./recovery.ts";

function error(overrides: Partial<FalrynError> = {}): FalrynError {
  return {
    code: "data.codec.malformed-json",
    category: "data",
    message: "A runtime event could not be interpreted.",
    retryable: true,
    effect: "none",
    cause: null,
    correlation: NO_CORRELATION,
    recovery: ["retry"],
    exitCategory: "runtime-error",
    related: [],
    relatedDropped: 0,
    recognized: true,
    ...overrides,
  };
}

function request(overrides: Partial<RetryRequest> = {}): RetryRequest {
  return {
    error: error(),
    policy: { maxAttempts: 3, retryable: true },
    attemptsMade: 1,
    elapsedMs: 0,
    elapsedBudgetMs: null,
    idempotent: true,
    cancelled: false,
    jitter: () => 0,
    ...overrides,
  };
}

describe("retry policy", () => {
  test("a retryable error is offered a retry, not retried automatically", () => {
    const decision = evaluateRetry(request());
    expect(decision.kind).toBe("retry");
    // The decision is a proposal — nothing here executed anything.
    if (decision.kind === "retry") {
      expect(decision.attempt).toBe(2);
    }
  });

  test("a non-retryable error is refused", () => {
    const decision = evaluateRetry(request({ error: error({ retryable: false }) }));
    expect(decision).toEqual({ kind: "do-not-retry", reason: "not-retryable" });
  });

  test("a policy that forbids retry overrides a retryable error", () => {
    const decision = evaluateRetry(request({ policy: { maxAttempts: 5, retryable: false } }));
    expect(decision).toEqual({ kind: "do-not-retry", reason: "not-retryable" });
  });

  test.each(["partial", "uncertain"] as const)(
    "an unobserved %s effect is refused before anything else is considered",
    (effect) => {
      const decision = evaluateRetry(request({ error: error({ effect }) }));
      expect(decision).toEqual({ kind: "do-not-retry", reason: "effect-not-observed" });
    },
  );

  test("a non-idempotent operation is refused once its effect is not none", () => {
    const decision = evaluateRetry(
      request({ error: error({ effect: "completed" }), idempotent: false }),
    );
    expect(decision).toEqual({ kind: "do-not-retry", reason: "not-idempotent" });
  });

  test("a non-idempotent operation whose effect never began may still retry", () => {
    expect(evaluateRetry(request({ idempotent: false })).kind).toBe("retry");
  });

  test("attempt count is honoured", () => {
    const decision = evaluateRetry(request({ attemptsMade: 3 }));
    expect(decision).toEqual({ kind: "do-not-retry", reason: "attempts-exhausted" });
  });

  test("elapsed budget is honoured", () => {
    const decision = evaluateRetry(request({ elapsedMs: 5_000, elapsedBudgetMs: 5_000 }));
    expect(decision).toEqual({ kind: "do-not-retry", reason: "elapsed-budget-exhausted" });
  });

  test("cancellation refuses before any other consideration", () => {
    const decision = evaluateRetry(
      request({ cancelled: true, error: error({ retryable: false }), attemptsMade: 99 }),
    );
    expect(decision).toEqual({ kind: "do-not-retry", reason: "cancelled" });
  });
});

describe("backoff", () => {
  test("grows exponentially and is capped", () => {
    const backoff = { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 };
    expect(backoffDelayMs(1, backoff, 0)).toBe(duration(100));
    expect(backoffDelayMs(2, backoff, 0)).toBe(duration(200));
    expect(backoffDelayMs(3, backoff, 0)).toBe(duration(400));
    expect(backoffDelayMs(4, backoff, 0)).toBe(duration(500));
    expect(backoffDelayMs(40, backoff, 0)).toBe(duration(500));
  });

  test("jitter spreads the delay within its declared ratio", () => {
    const backoff = { baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.25 };
    expect(backoffDelayMs(1, backoff, 0)).toBe(duration(1_000));
    expect(backoffDelayMs(1, backoff, 1)).toBe(duration(1_250));
    expect(backoffDelayMs(1, backoff, 0.5)).toBe(duration(1_125));
  });

  test("a jitter value outside its range is clamped rather than trusted", () => {
    const backoff = { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.5 };
    expect(backoffDelayMs(1, backoff, 99)).toBe(duration(150));
    expect(backoffDelayMs(1, backoff, -5)).toBe(duration(100));
  });

  test("the default backoff is bounded", () => {
    expect(backoffDelayMs(50, DEFAULT_RETRY_BACKOFF, 1)).toBeLessThanOrEqual(
      DEFAULT_RETRY_BACKOFF.maxDelayMs * (1 + DEFAULT_RETRY_BACKOFF.jitterRatio),
    );
  });

  test("waiting out a backoff is cancellable", async () => {
    const clock = createManualClock(instant(0));
    const decision = evaluateRetry(request());
    const controller = new AbortController();

    const waiting = awaitBackoff(clock, decision, controller.signal);
    controller.abort();
    expect(await waiting).toBe("cancelled");
  });

  test("waiting out a backoff resolves on the clock, not on wall time", async () => {
    const clock = createManualClock(instant(0));
    const decision = evaluateRetry(request());
    if (decision.kind !== "retry") {
      throw new Error("expected a retry");
    }

    const waiting = awaitBackoff(clock, decision);
    await clock.runUntilIdle();
    expect(await waiting).toBe("elapsed");
    expect(clock.now()).toBe(instant(decision.delayMs));
  });

  test("a refusal has nothing to wait for", async () => {
    const clock = createManualClock(instant(0));
    expect(await awaitBackoff(clock, { kind: "do-not-retry", reason: "cancelled" })).toBe(
      "elapsed",
    );
  });
});

describe("recovery catalog", () => {
  test("every action states its effects and prerequisite", () => {
    for (const action of RECOVERY_ACTIONS) {
      const description = describeRecovery(action);
      expect(description.action).toBe(action);
      expect(description.prerequisite.length).toBeGreaterThan(0);
    }
  });

  test("inspecting state is always safe and changes nothing", () => {
    const description = describeRecovery("inspect-state");
    expect(description.effects).toBeNull();
  });

  test("retrying names the duplication risk it carries", () => {
    expect(describeRecovery("retry").effects).toContain("repeat");
  });

  test("an error's plan describes each of its actions", () => {
    const plan = recoveryPlan(error({ effect: "partial", recovery: ["inspect-state"] }));
    expect(plan.map((step) => step.action)).toEqual(["inspect-state"]);
  });
});

describe("recovery after uncertainty", () => {
  test.each(["partial", "uncertain"] as const)(
    "a %s effect requires observation first",
    (effect) => {
      expect(requiresObservationFirst(error({ effect }))).toBe(true);
    },
  );

  test.each(["none", "completed"] as const)("an observed %s effect does not", (effect) => {
    expect(requiresObservationFirst(error({ effect }))).toBe(false);
  });

  test("planning refuses to act before state has been observed", () => {
    const uncertain = error({ effect: "uncertain" });
    const step = planRecovery(uncertain, request({ error: uncertain }), null);
    expect(step).toEqual({ kind: "observe-first", reason: "effect-not-observed" });
  });

  test("planning proceeds once an observation has been supplied", () => {
    const uncertain = error({ effect: "uncertain" });
    const step = planRecovery(uncertain, request({ error: uncertain }), {
      observed: "the file was not written",
      at: instant(10),
    });
    // Still not a retry — the effect was unobserved when it failed — but the
    // refusal is now a decision rather than a demand to look first.
    expect(step.kind).toBe("do-not-retry");
  });

  test("no completion is claimed from expected behavior", () => {
    const uncertain = error({ effect: "uncertain" });
    const step = planRecovery(uncertain, request({ error: uncertain }), null);
    expect(JSON.stringify(step)).not.toContain("completed");
  });

  test("an observed failure that never began may be retried", () => {
    const step = planRecovery(error(), request(), null);
    expect(step.kind).toBe("retry");
  });
});
