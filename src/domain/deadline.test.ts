import { describe, expect, test } from "bun:test";

import { createManualClock, duration, instant } from "./clock.ts";
import {
  deadlineAt,
  deadlineIn,
  deriveDeadline,
  enlargesDeadline,
  isExpired,
  remainingDuration,
} from "./deadline.ts";

describe("deadline derivation", () => {
  test("a child cannot enlarge what it inherited", () => {
    const inherited = deadlineAt(instant(1_000));
    const requested = deadlineAt(instant(5_000));
    expect(deriveDeadline(inherited, requested)).toEqual(inherited);
    expect(enlargesDeadline(inherited, requested)).toBe(true);
  });

  test("a tighter request wins", () => {
    const inherited = deadlineAt(instant(5_000));
    const requested = deadlineAt(instant(1_000));
    expect(deriveDeadline(inherited, requested)).toEqual(requested);
    expect(enlargesDeadline(inherited, requested)).toBe(false);
  });

  test("an absent limit on either side yields the other", () => {
    const only = deadlineAt(instant(1_000));
    expect(deriveDeadline(null, only)).toEqual(only);
    expect(deriveDeadline(only, null)).toEqual(only);
    expect(deriveDeadline(null, null)).toBeNull();
  });

  test("no limit anywhere never counts as enlarging", () => {
    expect(enlargesDeadline(null, deadlineAt(instant(1_000)))).toBe(false);
    expect(enlargesDeadline(deadlineAt(instant(1_000)), null)).toBe(false);
  });

  test("equal deadlines resolve to the inherited one", () => {
    const inherited = deadlineAt(instant(1_000));
    expect(deriveDeadline(inherited, deadlineAt(instant(1_000)))).toEqual(inherited);
  });
});

describe("deadline expiry", () => {
  test("is measured against the clock, not wall time", () => {
    const clock = createManualClock(instant(0));
    const deadline = deadlineIn(clock, duration(100));
    expect(deadline).toEqual(deadlineAt(instant(100)));
    expect(isExpired(deadline, clock)).toBe(false);
    expect(remainingDuration(deadline, clock)).toBe(duration(100));
  });

  test("expires exactly at its instant", async () => {
    const clock = createManualClock(instant(0));
    const deadline = deadlineAt(instant(100));
    await clock.advance(duration(99));
    expect(isExpired(deadline, clock)).toBe(false);
    await clock.advance(duration(1));
    expect(isExpired(deadline, clock)).toBe(true);
  });

  test("reports zero remaining once passed rather than a negative span", async () => {
    const clock = createManualClock(instant(0));
    const deadline = deadlineAt(instant(100));
    await clock.advance(duration(250));
    expect(remainingDuration(deadline, clock)).toBe(duration(0));
  });
});
