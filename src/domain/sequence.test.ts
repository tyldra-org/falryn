import { describe, expect, test } from "bun:test";

import {
  everyEventKind,
  FIXTURE_OTHER_STREAM,
  FIXTURE_STREAM,
  onOtherStream,
  sessionStarted,
  turnCompleted,
  turnStarted,
} from "./fixtures.ts";
import { eventId, idempotencyKey, sequence } from "./identity.ts";
import { createStreamSequencer, inspectReplay } from "./sequence.ts";

describe("monotonic sequencing within a stream", () => {
  test("accepts events in order", () => {
    const sequencer = createStreamSequencer();
    for (const event of everyEventKind()) {
      expect(sequencer.append(event)).toEqual({ kind: "appended", sequence: event.sequence });
    }
    expect(sequencer.lastSequence(FIXTURE_STREAM)).toBe(sequence.from(9));
    expect(sequencer.expectedSequence(FIXTURE_STREAM)).toBe(sequence.from(10));
  });

  test("requires a stream to begin at the first sequence", () => {
    const sequencer = createStreamSequencer();
    const decision = sequencer.append(turnStarted(2));
    expect(decision).toEqual({
      kind: "rejected",
      error: {
        code: "sequence-gap",
        streamId: FIXTURE_STREAM,
        expectedSequence: sequence.from(1),
        observedSequence: sequence.from(2),
      },
    });
  });

  test("rejects a gap without closing it", () => {
    const sequencer = createStreamSequencer();
    sequencer.append(sessionStarted(1));
    const decision = sequencer.append(turnCompleted(4));
    expect(decision.kind).toBe("rejected");
    if (decision.kind === "rejected") {
      expect(decision.error.code).toBe("sequence-gap");
    }
    expect(sequencer.lastSequence(FIXTURE_STREAM)).toBe(sequence.from(1));
  });

  test("rejects an out-of-order sequence", () => {
    const sequencer = createStreamSequencer();
    sequencer.append(sessionStarted(1));
    sequencer.append(turnStarted(2));
    const stale = { ...turnCompleted(3), sequence: sequence.from(2) };
    const decision = sequencer.append(stale);
    expect(decision.kind).toBe("rejected");
    if (decision.kind === "rejected") {
      expect(decision.error.code).toBe("sequence-out-of-order");
    }
  });

  test("rejects a duplicate sequence carried by a different event", () => {
    const sequencer = createStreamSequencer();
    sequencer.append(sessionStarted(1));
    sequencer.append(turnStarted(2));
    const conflicting = { ...turnCompleted(3), sequence: sequence.from(2) };
    const decision = sequencer.append(conflicting);
    expect(decision.kind).toBe("rejected");
  });
});

describe("idempotency", () => {
  test("a repeated append is a no-op, not a second event", () => {
    const sequencer = createStreamSequencer();
    const event = sessionStarted(1);
    expect(sequencer.append(event).kind).toBe("appended");
    expect(sequencer.append(event)).toEqual({ kind: "duplicate", sequence: event.sequence });
    expect(sequencer.trackedEventCount(FIXTURE_STREAM)).toBe(1);
    expect(sequencer.lastSequence(FIXTURE_STREAM)).toBe(sequence.from(1));
  });

  test("reusing an idempotency key for a different event is a conflict", () => {
    const sequencer = createStreamSequencer();
    const first = sessionStarted(1);
    sequencer.append(first);
    const impostor = {
      ...turnStarted(2),
      idempotencyKey: first.idempotencyKey,
    };
    const decision = sequencer.append(impostor);
    expect(decision.kind).toBe("rejected");
    if (decision.kind === "rejected") {
      expect(decision.error.code).toBe("idempotency-conflict");
    }
  });

  test("reusing an event identifier under a new key is a conflict", () => {
    const sequencer = createStreamSequencer();
    const first = sessionStarted(1);
    sequencer.append(first);
    const impostor = {
      ...turnStarted(2),
      eventId: first.eventId,
      idempotencyKey: idempotencyKey.from("key-retry"),
    };
    const decision = sequencer.append(impostor);
    expect(decision.kind).toBe("rejected");
    if (decision.kind === "rejected") {
      expect(decision.error.code).toBe("event-id-conflict");
    }
  });
});

describe("stream isolation", () => {
  test("interleaved streams keep independent sequences", () => {
    const sequencer = createStreamSequencer();
    const decisions = [
      sequencer.append(sessionStarted(1)),
      sequencer.append(onOtherStream(sessionStarted(1))),
      sequencer.append(turnStarted(2)),
      sequencer.append(onOtherStream(turnStarted(2))),
    ];
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "appended",
      "appended",
      "appended",
      "appended",
    ]);
    expect(sequencer.lastSequence(FIXTURE_STREAM)).toBe(sequence.from(2));
    expect(sequencer.lastSequence(FIXTURE_OTHER_STREAM)).toBe(sequence.from(2));
    expect(sequencer.streams()).toEqual([FIXTURE_STREAM, FIXTURE_OTHER_STREAM]);
  });

  test("a stream that has seen nothing expects the first sequence", () => {
    const sequencer = createStreamSequencer();
    expect(sequencer.lastSequence(FIXTURE_OTHER_STREAM)).toBeNull();
    expect(sequencer.expectedSequence(FIXTURE_OTHER_STREAM)).toBe(sequence.from(1));
  });
});

describe("replay inspection", () => {
  test("reports a clean replay", () => {
    const report = inspectReplay(everyEventKind());
    expect(report.appended).toBe(9);
    expect(report.duplicates).toBe(0);
    expect(report.anomalies).toEqual([]);
    expect(report.streams).toEqual([FIXTURE_STREAM]);
  });

  test("locates out-of-order, duplicate, and gapped records", () => {
    const stale = { ...turnStarted(2), eventId: eventId.from("event-stale") };
    const report = inspectReplay([
      sessionStarted(1),
      turnStarted(2),
      turnCompleted(3),
      { ...stale, idempotencyKey: idempotencyKey.from("key-stale") },
      turnCompleted(3),
      turnCompleted(7),
    ]);

    expect(report.appended).toBe(3);
    expect(report.duplicates).toBe(1);
    expect(report.anomalies.map((anomaly) => [anomaly.index, anomaly.error.code])).toEqual([
      [3, "sequence-out-of-order"],
      [5, "sequence-gap"],
    ]);
  });

  test("does not repair what it observes", () => {
    const report = inspectReplay([sessionStarted(1), turnCompleted(5)]);
    expect(report.appended).toBe(1);
    expect(report.anomalies).toHaveLength(1);
  });
});
