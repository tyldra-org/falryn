/**
 * Sequence anomalies, detected rather than smoothed over.
 *
 * A transcript built from an incomplete run of events is not a shorter
 * transcript — it is a wrong one, and it looks exactly like a right one. A
 * missing `capability.invocation.completed` leaves a tool call that appears to
 * still be running; a missing `turn.completed` leaves a turn that never ended.
 * Neither is distinguishable from the real thing by looking at it, which is why
 * detection has to happen at the sequence level, before anything is rendered.
 *
 * The three anomalies below are separate because their causes are separate. A
 * gap is lost or not-yet-read events. A repeat is a stream folded twice. An
 * out-of-order arrival is a caller handing over an unsorted run. Reporting all
 * three as "gap" would send someone looking for missing rows when the real
 * problem is that they sorted by timestamp somewhere.
 *
 * Detection reports. It does not throw, and it does not drop the events — a
 * transcript with a hole in it and a note about the hole is more useful than no
 * transcript, and far more useful than a seamless one.
 */

import type { RuntimeEvent, Sequence, StreamId } from "../../domain/index.ts";
import { assertNever } from "../../domain/index.ts";

export type SequenceAnomaly =
  /** Events between two applied sequences were never seen. */
  | {
      readonly kind: "gap";
      readonly streamId: StreamId;
      readonly after: Sequence;
      readonly before: Sequence;
      readonly missing: number;
    }
  /** The same sequence arrived twice on one stream. */
  | { readonly kind: "repeated"; readonly streamId: StreamId; readonly sequence: Sequence }
  /** A sequence arrived after a higher one on the same stream. */
  | {
      readonly kind: "out-of-order";
      readonly streamId: StreamId;
      readonly sequence: Sequence;
      readonly after: Sequence;
    };

/**
 * Where each stream was already folded to.
 *
 * Supplied when resuming: without it, a run that legitimately starts at
 * sequence 40 is indistinguishable from one that lost the first 39 events. With
 * it, the same run is checked against where the reader actually left off.
 */
export type ResumePoint = ReadonlyMap<StreamId, Sequence>;

/**
 * Walks an ordered run and reports what does not line up.
 *
 * Per stream, because sequences are per stream. Interleaved streams are
 * ordinary — two sessions producing events at once is not an anomaly, and a
 * detector that compared their sequences to each other would report nothing but
 * anomalies.
 */
export function detectAnomalies(
  events: readonly RuntimeEvent[],
  resumedAfter: ResumePoint = new Map(),
): readonly SequenceAnomaly[] {
  const anomalies: SequenceAnomaly[] = [];
  const seen = new Map<StreamId, Sequence>();

  for (const event of events) {
    const { streamId, sequence } = event;
    const previous = seen.get(streamId) ?? resumedAfter.get(streamId);
    if (previous === undefined) {
      // The first event of a stream with no resume point. Nothing to compare
      // against: a stream may legitimately be read from anywhere when nobody
      // claimed to have read it before.
      seen.set(streamId, sequence);
      continue;
    }
    if (sequence === previous) {
      anomalies.push({ kind: "repeated", streamId, sequence });
      continue;
    }
    if (sequence < previous) {
      anomalies.push({ kind: "out-of-order", streamId, sequence, after: previous });
      continue;
    }
    if (sequence > previous + 1) {
      anomalies.push({
        kind: "gap",
        streamId,
        after: previous,
        before: sequence,
        missing: sequence - previous - 1,
      });
    }
    seen.set(streamId, sequence);
  }

  return anomalies;
}

/** What went wrong, in words, for a view that has to say so. */
export function describeAnomaly(anomaly: SequenceAnomaly): string {
  switch (anomaly.kind) {
    case "gap":
      return `${anomaly.missing} events between ${anomaly.after} and ${anomaly.before} were not seen.`;
    case "repeated":
      return `Sequence ${anomaly.sequence} arrived more than once.`;
    case "out-of-order":
      return `Sequence ${anomaly.sequence} arrived after ${anomaly.after}.`;
    default:
      return assertNever(anomaly, "unhandled sequence anomaly");
  }
}
