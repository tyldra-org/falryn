import { describe, expect, test } from "bun:test";

import {
  addDuration,
  createManualClock,
  createSystemClock,
  duration,
  elapsedBetween,
  instant,
  instantToTimestamp,
  parseDuration,
  parseInstant,
  type WaitOutcome,
  ZERO_DURATION,
} from "./clock.ts";

describe("time values", () => {
  test("rejects a non-integer instant", () => {
    const parsed = parseInstant(1.5);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("not-an-integer");
    }
  });

  test("rejects a negative duration", () => {
    const parsed = parseDuration(-1);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("out-of-range");
    }
  });

  test("accepts a zero duration", () => {
    expect(parseDuration(0).ok).toBe(true);
    expect(ZERO_DURATION).toBe(duration(0));
  });

  test("elapsed time never goes negative", () => {
    expect(elapsedBetween(instant(100), instant(40))).toBe(duration(0));
    expect(elapsedBetween(instant(40), instant(100))).toBe(duration(60));
  });

  test("renders an instant as a canonical timestamp", () => {
    expect(String(instantToTimestamp(instant(Date.UTC(2026, 6, 31))))).toBe(
      "2026-07-31T00:00:00.000Z",
    );
  });
});

describe("manual clock", () => {
  test("does not move on its own", async () => {
    const clock = createManualClock(instant(1_000));
    expect(clock.now()).toBe(instant(1_000));
    await clock.advance(duration(0));
    expect(clock.now()).toBe(instant(1_000));
  });

  test("releases a wait when the clock reaches it", async () => {
    const clock = createManualClock(instant(0));
    const outcomes: WaitOutcome[] = [];
    const waiting = clock.waitUntil(instant(500)).then((result) => {
      outcomes.push(result);
    });

    await clock.advance(duration(499));
    expect(outcomes).toEqual([]);
    expect(clock.pendingWaitCount()).toBe(1);

    await clock.advance(duration(1));
    await waiting;
    expect(outcomes).toEqual(["reached"]);
    expect(clock.pendingWaitCount()).toBe(0);
  });

  test("resolves a wait already in the past without advancing", async () => {
    const clock = createManualClock(instant(1_000));
    expect(await clock.waitUntil(instant(10))).toBe("reached");
  });

  test("reports an aborted wait as aborted, not reached", async () => {
    const clock = createManualClock(instant(0));
    const controller = new AbortController();
    const waiting = clock.waitUntil(instant(500), controller.signal);
    controller.abort();
    expect(await waiting).toBe("aborted");
    expect(clock.pendingWaitCount()).toBe(0);
  });

  test("reports an already-aborted wait without registering it", async () => {
    const clock = createManualClock(instant(0));
    const controller = new AbortController();
    controller.abort();
    expect(await clock.waitUntil(instant(500), controller.signal)).toBe("aborted");
    expect(clock.pendingWaitCount()).toBe(0);
  });

  test("never moves backwards", async () => {
    const clock = createManualClock(instant(1_000));
    await clock.advanceTo(instant(10));
    expect(clock.now()).toBe(instant(1_000));
  });

  test("runUntilIdle jumps to each scheduled wait in turn", async () => {
    const clock = createManualClock(instant(0));
    const reached: number[] = [];
    void clock.waitUntil(instant(300)).then(() => reached.push(300));
    void clock.waitUntil(instant(100)).then(() => reached.push(100));

    await clock.runUntilIdle();
    expect(reached).toEqual([100, 300]);
    expect(clock.now()).toBe(instant(300));
  });

  test("runUntilIdle refuses to spin forever", async () => {
    const clock = createManualClock(instant(0));
    const rearm = (): void => {
      void clock.waitUntil(addDuration(clock.now(), duration(10))).then(rearm);
    };
    rearm();
    await expect(clock.runUntilIdle(5)).rejects.toThrow("did not go idle");
  });
});

describe("system clock", () => {
  test("reports a plausible current instant", () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.now();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  test("resolves a wait that has already passed", async () => {
    const clock = createSystemClock();
    expect(await clock.waitUntil(instant(0))).toBe("reached");
  });

  test("reports abort rather than reached", async () => {
    const clock = createSystemClock();
    const controller = new AbortController();
    const waiting = clock.waitUntil(addDuration(clock.now(), duration(60_000)), controller.signal);
    controller.abort();
    expect(await waiting).toBe("aborted");
  });
});
