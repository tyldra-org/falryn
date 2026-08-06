import { describe, expect, test } from "bun:test";
import { createManualClock, duration, instant } from "../../domain/index.ts";
import {
  type ClickSequence,
  REPEATED_PRESS_WINDOW,
  type TerminalCell,
  transitionClickSequence,
} from "./click-sequence.ts";

const CELL: TerminalCell = { x: 12, y: 4 };

function primary(
  previous: ClickSequence | null,
  at: ReturnType<typeof instant>,
  cell: TerminalCell = CELL,
) {
  return transitionClickSequence(previous, { kind: "press", button: "primary", cell }, at);
}

describe("the composer repeated-press policy", () => {
  test("continues at zero and exactly 400 milliseconds", async () => {
    const clock = createManualClock(instant(10));
    const first = primary(null, clock.now());
    const sameMoment = primary(first.sequence, clock.now());
    await clock.advance(REPEATED_PRESS_WINDOW);
    const boundary = primary(sameMoment.sequence, clock.now());

    expect(first.count).toBe(1);
    expect(sameMoment.count).toBe(2);
    expect(boundary.count).toBe(3);
  });

  test("starts again after the inclusive window", async () => {
    const clock = createManualClock();
    const first = primary(null, clock.now());
    await clock.advance(duration(401));

    const expired = primary(first.sequence, clock.now());
    expect(expired.count).toBe(1);
  });

  test("cycles from the third qualifying press back to one", () => {
    const clock = createManualClock();
    const first = primary(null, clock.now());
    const second = primary(first.sequence, clock.now());
    const third = primary(second.sequence, clock.now());
    const fourth = primary(third.sequence, clock.now());

    expect([first.count, second.count, third.count, fourth.count]).toEqual([1, 2, 3, 1]);
  });

  test("resets for another cell, a backward clock, a non-primary press, and a drag", () => {
    const clock = createManualClock(instant(20));
    const first = primary(null, clock.now());

    expect(primary(first.sequence, clock.now(), { x: CELL.x + 1, y: CELL.y }).count).toBe(1);
    expect(primary(first.sequence, instant(19)).count).toBe(1);

    const nonPrimary = transitionClickSequence(
      first.sequence,
      { kind: "press", button: "other", cell: CELL },
      clock.now(),
    );
    expect(nonPrimary).toEqual({ sequence: null, count: null });

    const drag = transitionClickSequence(first.sequence, { kind: "drag" }, clock.now());
    expect(drag).toEqual({ sequence: null, count: null });
  });
});
