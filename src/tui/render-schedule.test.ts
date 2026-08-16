/**
 * Coalescing changes how often a view commits. It does not change what happened.
 *
 * The schedule is the whole contract in one place: stream notes share a
 * cadence, input and semantic notes flush now, and a hold is one snapshot
 * rather than a queue of frames. The hook that drives React is a consumer of
 * these decisions; these tests never mount a renderer.
 */

import { describe, expect, test } from "bun:test";
import { duration, instant } from "../domain/index.ts";
import {
  dueRender,
  IDLE_RENDER_SCHEDULE,
  noteRender,
  type RenderSchedule,
  STREAM_PUBLISH_CADENCE,
} from "./render-schedule.ts";

const T0 = instant(0);
const CADENCE = STREAM_PUBLISH_CADENCE;

function apply(
  schedule: RenderSchedule,
  kind: "stream" | "input" | "semantic",
  at: number,
): RenderSchedule {
  return noteRender(schedule, kind, instant(at), CADENCE).schedule;
}

describe("the first stream update", () => {
  test("publishes immediately so a quiet session is not waiting on cadence", () => {
    const decision = noteRender(IDLE_RENDER_SCHEDULE, "stream", T0);
    expect(decision.publish).toBe(true);
    expect(decision.schedule.pending).toBe(false);
    expect(decision.schedule.coalesced).toBe(0);
  });
});

describe("a stream burst inside the cadence", () => {
  test("holds later notes instead of publishing each one", () => {
    let schedule = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    const second = noteRender(schedule, "stream", instant(1), CADENCE);
    expect(second.publish).toBe(false);
    schedule = second.schedule;
    for (let at = 2; at <= 10; at += 1) {
      const next = noteRender(schedule, "stream", instant(at), CADENCE);
      expect(next.publish).toBe(false);
      schedule = next.schedule;
    }
    expect(schedule.pending).toBe(true);
    expect(schedule.coalesced).toBe(10);
  });

  test("publishes the hold once the cadence elapses", () => {
    let schedule = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    schedule = apply(schedule, "stream", 1);
    const due = dueRender(schedule, instant(16));
    expect(due.publish).toBe(true);
    expect(due.schedule.pending).toBe(false);
    expect(due.schedule.coalesced).toBe(1);
  });

  test("does not publish a hold that is not yet due", () => {
    let schedule = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    schedule = apply(schedule, "stream", 1);
    expect(dueRender(schedule, instant(15)).publish).toBe(false);
  });
});

describe("input during a hold", () => {
  test("publishes immediately and takes the held stream notes with it", () => {
    let schedule = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    schedule = apply(schedule, "stream", 1);
    schedule = apply(schedule, "stream", 2);
    const decision = noteRender(schedule, "input", instant(3), CADENCE);
    expect(decision.publish).toBe(true);
    expect(decision.schedule.pending).toBe(false);
    expect(decision.schedule.coalesced).toBe(2);
  });
});

describe("a semantic fact during a hold", () => {
  test("publishes immediately rather than waiting for cadence", () => {
    let schedule = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    schedule = apply(schedule, "stream", 1);
    const decision = noteRender(schedule, "semantic", instant(2), CADENCE);
    expect(decision.publish).toBe(true);
    expect(decision.schedule.pending).toBe(false);
  });
});

describe("a later stream after cadence", () => {
  test("publishes without holding, because the quiet window already passed", () => {
    const after = apply(IDLE_RENDER_SCHEDULE, "stream", 0);
    const decision = noteRender(after, "stream", instant(16), CADENCE);
    expect(decision.publish).toBe(true);
    expect(decision.schedule.coalesced).toBe(0);
  });
});

describe("the cadence", () => {
  test("is one 60 Hz frame, not an invented latency SLO", () => {
    expect(CADENCE).toBe(duration(16));
  });

  test("does not read the wall clock or a second animation frame", async () => {
    const source = await Bun.file(new URL("./render-schedule.ts", import.meta.url)).text();
    expect(source.includes("Date.now(")).toBe(false);
    expect(source.includes("requestAnimationFrame(")).toBe(false);
  });
});
