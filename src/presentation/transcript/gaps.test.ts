/**
 * A transcript with a hole in it looks exactly like one without.
 *
 * That is the whole reason this module exists. A missing
 * `capability.invocation.completed` leaves a tool call that appears to still be
 * running; a missing `turn.completed` leaves a turn that never ended. Neither
 * is detectable by looking at the result, so it has to be detected at the
 * sequence level, before anything is rendered.
 *
 * The three anomalies are kept apart because their causes are. Reporting an
 * unsorted run as a gap sends someone looking for lost events when the real
 * problem is a `sort` somewhere upstream.
 */

import { describe, expect, test } from "bun:test";
import {
  capabilityInvocationCompleted,
  capabilityInvocationStarted,
  FIXTURE_OTHER_STREAM,
  FIXTURE_STREAM,
  onOtherStream,
  sessionStarted,
  turnCompleted,
  turnStarted,
} from "../../domain/fixtures.ts";
import type { Sequence, StreamId } from "../../domain/index.ts";
import { sequence } from "../../domain/index.ts";
import { describeAnomaly, detectAnomalies } from "./gaps.ts";

/** Sequences are branded, so a literal has to go through the domain's codec. */
const seq = (position: number): Sequence => sequence.from(position);

describe("a contiguous run", () => {
  test("has nothing to report", () => {
    expect(detectAnomalies([sessionStarted(1), turnStarted(2), turnCompleted(3)])).toEqual([]);
  });

  test("is still contiguous when two streams interleave", () => {
    // Two sessions producing events at once is ordinary. A detector comparing
    // their sequences to each other would report nothing but anomalies.
    const events = [
      sessionStarted(1),
      onOtherStream(sessionStarted(1)),
      turnStarted(2),
      onOtherStream(turnStarted(2)),
    ];
    expect(detectAnomalies(events)).toEqual([]);
  });
});

describe("a run with events missing", () => {
  test("reports the gap and how many were lost", () => {
    const anomalies = detectAnomalies([sessionStarted(1), turnCompleted(5)]);
    expect(anomalies).toEqual([
      { kind: "gap", streamId: FIXTURE_STREAM, after: seq(1), before: seq(5), missing: 3 },
    ]);
  });

  test("reports one gap per stream rather than one for the run", () => {
    const anomalies = detectAnomalies([
      sessionStarted(1),
      onOtherStream(sessionStarted(1)),
      turnCompleted(4),
      onOtherStream(turnCompleted(9)),
    ]);
    expect(anomalies.map((anomaly) => anomaly.streamId)).toEqual([
      FIXTURE_STREAM,
      FIXTURE_OTHER_STREAM,
    ]);
    expect(anomalies.map((anomaly) => (anomaly.kind === "gap" ? anomaly.missing : -1))).toEqual([
      2, 7,
    ]);
  });
});

describe("a run delivered twice", () => {
  test("reports the repeat rather than a gap", () => {
    expect(detectAnomalies([sessionStarted(1), turnStarted(1)])).toEqual([
      { kind: "repeated", streamId: FIXTURE_STREAM, sequence: seq(1) },
    ]);
  });
});

describe("a run that arrived out of order", () => {
  test("says so rather than pointing at missing events", () => {
    // The distinction that saves an afternoon: nothing is lost here, the caller
    // sorted by something other than sequence.
    expect(detectAnomalies([turnCompleted(5), sessionStarted(2)])).toEqual([
      { kind: "out-of-order", streamId: FIXTURE_STREAM, sequence: seq(2), after: seq(5) },
    ]);
  });
});

describe("the first event of a stream", () => {
  test("is not an anomaly when nobody claimed to have read the stream", () => {
    // A stream may legitimately be read from anywhere. Treating a run that
    // starts at 40 as 39 lost events would make every partial read an alarm.
    expect(detectAnomalies([turnCompleted(40)])).toEqual([]);
  });

  test("is checked against a resume point when one is given", () => {
    // With a resume point the same run is checked against where the reader
    // actually left off, which is the only way the two cases can be told apart.
    const resumed = new Map<StreamId, Sequence>([[FIXTURE_STREAM, seq(10)]]);
    expect(detectAnomalies([turnCompleted(40)], resumed)).toEqual([
      { kind: "gap", streamId: FIXTURE_STREAM, after: seq(10), before: seq(40), missing: 29 },
    ]);
  });

  test("is clean when it continues exactly from the resume point", () => {
    const resumed = new Map<StreamId, Sequence>([[FIXTURE_STREAM, seq(5)]]);
    expect(detectAnomalies([turnCompleted(6)], resumed)).toEqual([]);
  });
});

describe("what a view is told", () => {
  test("describes each anomaly in words that differ", () => {
    const anomalies = [
      ...detectAnomalies([sessionStarted(1), turnCompleted(5)]),
      ...detectAnomalies([capabilityInvocationStarted(1), capabilityInvocationCompleted(1)]),
      ...detectAnomalies([turnCompleted(5), sessionStarted(2)]),
    ];
    const described = anomalies.map(describeAnomaly);
    expect(described).toHaveLength(3);
    expect(new Set(described).size).toBe(3);
    expect(described.every((sentence) => sentence.length > 0)).toBe(true);
  });
});
