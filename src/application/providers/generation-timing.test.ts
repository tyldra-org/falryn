import { describe, expect, test } from "bun:test";
import {
  type ClockPort,
  createManualClock,
  duration,
  instant,
  modelAttemptId,
} from "../../domain/foundation/index.ts";
import { modelRequestId } from "../../providers/configuration/identity.ts";
import type { NormalizedProviderEvent } from "../../providers/index.ts";
import {
  createGenerationActivity,
  createGenerationTimingRecorder,
  type GenerationLiveUpdate,
} from "./generation-timing.ts";

const spine = {
  requestId: modelRequestId.from("request-1"),
  modelAttemptId: modelAttemptId.from("attempt-1"),
};

function text(sequence: number, value: string): NormalizedProviderEvent {
  return { ...spine, sequence, kind: "text-delta", text: value };
}

function settableClock(start: number): ClockPort & { set(value: number): void } {
  let now = start;
  return {
    now: () => instant(now),
    waitUntil: async () => "reached",
    set(value) {
      now = value;
    },
  };
}

describe("generation timing recorder", () => {
  test("times from begin to first delta to terminal and publishes live updates at most every 250 ms", async () => {
    const clock = createManualClock(instant(1_000));
    const live: GenerationLiveUpdate[] = [];
    const recorder = createGenerationTimingRecorder({
      clock,
      modelAttemptId: "attempt-1",
      requestId: "request-1",
      sink: { live: (update) => live.push(update), settled: () => {} },
    });
    recorder.begin();
    await clock.advance(duration(200));
    recorder.observe(text(1, "x".repeat(40))); // 10 tokens at 1200: first live update
    await clock.advance(duration(249));
    recorder.observe(text(2, "x".repeat(40))); // 1449: throttled
    await clock.advance(duration(1));
    recorder.observe(text(3, "x".repeat(40))); // 1450: exactly 250 ms later
    await clock.advance(duration(550));
    recorder.observe(text(4, "x".repeat(40))); // 2000
    recorder.observe({
      ...spine,
      sequence: 5,
      kind: "tool-call-delta",
      toolCallId: "t",
      argumentsFragment: "{",
    });
    await clock.advance(duration(1_000));
    recorder.end(); // 3000
    await clock.advance(duration(5_000));
    const timing = recorder.finish("complete", {
      provenance: "provider-reported",
      outputTokens: 36,
    });

    // 1200: no span yet. 1450: exactly 250 ms and 30 tokens (the throttled
    // delta still counts). 2000: 40 tokens over 800 ms.
    expect(live.map((update) => update.rate)).toEqual([
      { kind: "insufficient-sample", source: "estimate" },
      { kind: "measured", tokensPerSecond: 120, source: "estimate" },
      { kind: "measured", tokensPerSecond: 50, source: "estimate" },
    ]);
    // The wait after `end` belongs to nothing: generation is 1200 → 3000.
    expect(timing).toMatchObject({
      timeToFirstTokenMs: 200,
      generationMs: 1_800,
      tokens: { source: "provider-reported", output: 36, reasoning: null },
      rate: { kind: "measured", tokensPerSecond: 20, source: "provider-reported" },
    });
  });

  test("estimates tokens over cumulative text so small deltas are not each rounded up", () => {
    const clock = createManualClock(instant(0));
    const recorder = createGenerationTimingRecorder({
      clock,
      modelAttemptId: "attempt-1",
      requestId: "request-1",
    });
    recorder.begin();
    for (let index = 1; index <= 40; index += 1) recorder.observe(text(index, "x"));
    recorder.observe({ ...spine, sequence: 41, kind: "reasoning-delta", text: "y".repeat(8) });
    const timing = recorder.finish("complete", null);
    expect(timing?.tokens).toEqual({ source: "estimate", output: 12, reasoning: 2 });
  });

  test("a clock reading that goes backwards makes the rate unavailable", () => {
    const clock = settableClock(5_000);
    const live: GenerationLiveUpdate[] = [];
    const recorder = createGenerationTimingRecorder({
      clock,
      modelAttemptId: "attempt-1",
      requestId: "request-1",
      sink: { live: (update) => live.push(update), settled: () => {} },
    });
    recorder.begin();
    clock.set(5_500);
    recorder.observe(text(1, "x".repeat(400)));
    clock.set(4_000);
    recorder.observe(text(2, "x".repeat(400)));
    clock.set(9_000);
    const timing = recorder.finish("complete", null);
    expect(timing?.rate).toEqual({ kind: "unavailable", reason: "clock-anomaly" });
    expect(timing?.generationMs).toBeNull();
    expect(timing?.tokens).toEqual({ source: "estimate", output: 200, reasoning: null });
    // No live rate is published once the clock is known to be unreliable.
    expect(live).toHaveLength(1);
  });

  test("a stream that never began yields no fact", () => {
    const recorder = createGenerationTimingRecorder({
      clock: createManualClock(instant(0)),
      modelAttemptId: "attempt-1",
      requestId: "request-1",
    });
    recorder.observe(text(1, "ignored"));
    expect(recorder.finish("partial", null)).toBeNull();
  });
});

describe("generation activity", () => {
  test("publishes live then final entries and notifies subscribers", async () => {
    const clock = createManualClock(instant(0));
    const activity = createGenerationActivity();
    let notified = 0;
    const unsubscribe = activity.subscribe(() => {
      notified += 1;
    });
    const recorder = createGenerationTimingRecorder({
      clock,
      modelAttemptId: "attempt-1",
      requestId: "request-1",
      sink: activity.sinkFor("turn-1"),
    });
    recorder.begin();
    recorder.observe(text(1, "hello"));
    expect(activity.current()).toMatchObject({ phase: "live", turnId: "turn-1" });
    await clock.advance(duration(10));
    recorder.finish("partial", null);
    expect(activity.current()).toMatchObject({
      phase: "final",
      turnId: "turn-1",
      timing: { completion: "partial" },
    });
    expect(notified).toBe(2);
    unsubscribe();
    recorder.finish("complete", null);
    expect(notified).toBe(2);
  });

  test("a parent and two children keep separate activities and rates", async () => {
    const clock = createManualClock(instant(0));
    const parent = createGenerationActivity();
    const children = [createGenerationActivity(), createGenerationActivity()];
    const recorders = [parent, ...children].map((activity, index) =>
      createGenerationTimingRecorder({
        clock,
        modelAttemptId: `attempt-${index}`,
        requestId: `request-${index}`,
        sink: activity.sinkFor(`turn-${index}`),
      }),
    );
    for (const recorder of recorders) recorder.begin();
    for (let step = 1; step <= 4; step += 1) {
      await clock.advance(duration(250));
      recorders.forEach((recorder, index) => {
        recorder.observe(text(step, "x".repeat(40 * (index + 1))));
      });
    }
    const rates = [parent, ...children].map((activity) => {
      const entry = activity.current();
      return entry?.phase === "live" ? entry.rate : null;
    });
    expect(rates).toEqual([
      { kind: "measured", tokensPerSecond: 53.3, source: "estimate" },
      { kind: "measured", tokensPerSecond: 106.7, source: "estimate" },
      { kind: "measured", tokensPerSecond: 160, source: "estimate" },
    ]);
  });
});
