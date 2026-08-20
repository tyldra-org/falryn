/**
 * Transcript feed over a session/turn producer (#706).
 *
 * Mirrors {@link runtimeFeed}: read-only events + subscribe, folded through
 * {@link reduceTranscript}. Views never hold the producer itself.
 */

import { useEffect, useRef, useState } from "react";
import type { SessionTurnTranscriptProducer } from "../application/session-turn-transcript-producer.ts";
import type { RuntimeEvent } from "../domain/index.ts";
import {
  EMPTY_PROJECTION,
  reduceTranscript,
  type TranscriptProjection,
} from "../presentation/index.ts";
import { IMMEDIATE_GATE, type RenderGate } from "./components/render-gate.tsx";
import type { RenderKind } from "./render-schedule.ts";

export type TranscriptFeed = {
  events(): readonly RuntimeEvent[];
  subscribe(listener: () => void): () => void;
};

export function transcriptFeedFromProducer(
  producer: SessionTurnTranscriptProducer,
): TranscriptFeed {
  return {
    events: () => producer.events(),
    subscribe: (listener) => producer.subscribe(listener),
  };
}

export function useTranscriptProjection(
  feed?: TranscriptFeed,
  gate: RenderGate = IMMEDIATE_GATE,
): TranscriptProjection {
  const held = useRef<TranscriptProjection>(
    feed === undefined ? EMPTY_PROJECTION : reduceTranscript(feed.events()),
  );
  const [projection, setProjection] = useState<TranscriptProjection>(() => held.current);

  useEffect(() => {
    const unsubscribeDue = gate.onDue(() => {
      setProjection(held.current);
    });

    const publish = (next: TranscriptProjection, kind: RenderKind): void => {
      held.current = next;
      if (gate.note(kind)) {
        setProjection(held.current);
      }
    };

    if (feed === undefined) {
      publish(EMPTY_PROJECTION, "semantic");
      return unsubscribeDue;
    }

    const first = reduceTranscript(feed.events());
    if (first !== held.current) {
      publish(first, first.blocks.length > held.current.blocks.length ? "semantic" : "stream");
    } else if (held.current.blocks.length > 0) {
      gate.note("stream");
    }

    const unsubscribeFeed = feed.subscribe(() => {
      const previous = held.current;
      const next = reduceTranscript(feed.events());
      if (
        next.blocks.length === previous.blocks.length &&
        next.anomalies.length === previous.anomalies.length &&
        next.refusedRevisions === previous.refusedRevisions
      ) {
        // Same fold shape — still replace when contents differ by reference.
        const same =
          next.blocks.every((block, index) => block === previous.blocks[index]) &&
          next.anomalies.every((anomaly, index) => anomaly === previous.anomalies[index]);
        if (same) {
          return;
        }
      }
      publish(next, next.blocks.length > previous.blocks.length ? "semantic" : "stream");
    });

    return () => {
      unsubscribeFeed();
      unsubscribeDue();
    };
  }, [feed, gate]);

  return projection;
}
