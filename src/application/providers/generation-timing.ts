/**
 * Generation timing capture and its live projection.
 *
 * `timeProviderStream` taps the adapter stream where events first reach
 * Falryn: before history capture holds deltas in batches until they are
 * durable, and before the consumer's bounded queue can coalesce them. Neither
 * can therefore change a recorded time or token count. The attempt runner
 * settles the recorder once the stream ends and carries the final fact to the
 * attempt receipt. Live updates are rate-limited by the recorder, which is the
 * projection owner: views only read the latest entry and never compute a rate.
 */

import { estimateTokensForLength } from "../../domain/context/index.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import {
  GENERATION_LIVE_INTERVAL_MS,
  GENERATION_LIVE_WINDOW_MS,
  type GenerationDeltaSample,
  type GenerationRate,
  type GenerationTiming,
  type GenerationUsage,
  liveGenerationRate,
  summarizeGeneration,
} from "../../domain/sessions/index.ts";
import type { NormalizedProviderEvent } from "../../providers/index.ts";

export type GenerationLiveUpdate = {
  readonly modelAttemptId: string;
  readonly requestId: string;
  readonly rate: GenerationRate;
};

/** Where one attempt's timing is published while it runs and when it settles. */
export type GenerationTimingSink = {
  live(update: GenerationLiveUpdate): void;
  settled(timing: GenerationTiming): void;
};

export type GenerationTimingRecorder = {
  /** Marks the request start. The first call wins. */
  begin(): void;
  /** Records one received event. Must run before any batching or coalescing. */
  observe(event: NormalizedProviderEvent): void;
  /** Marks the stream terminal. The first call wins. */
  end(): void;
  /**
   * Derives the final fact and publishes it once. Later calls return the same
   * fact, so an owner that must settle before the stream does (cancellation)
   * records it as partial and a late completion cannot rewrite it. Null when
   * the stream never began, because no provider request was consumed.
   */
  finish(
    completion: "complete" | "partial",
    usage: GenerationUsage | null,
  ): GenerationTiming | null;
};

/** Distinct instants retained for the live window; one per clock tick at most. */
const MAX_LIVE_SAMPLES = GENERATION_LIVE_WINDOW_MS + 1;

export function createGenerationTimingRecorder(options: {
  readonly clock: ClockPort;
  readonly modelAttemptId: string;
  readonly requestId: string;
  readonly sink?: GenerationTimingSink | undefined;
}): GenerationTimingRecorder {
  let lastReading: number | null = null;
  let clockAnomaly = false;
  let startedAt: number | null = null;
  let firstOutputAt: number | null = null;
  let terminalAt: number | null = null;
  let lastLiveAt: number | null = null;
  const characters = { text: 0, reasoning: 0 };
  const estimated = { text: 0, reasoning: 0 };
  const samples: GenerationDeltaSample[] = [];
  let settled: { readonly timing: GenerationTiming | null } | null = null;

  const read = (): number => {
    const now = Number(options.clock.now());
    if (lastReading !== null && now < lastReading) clockAnomaly = true;
    lastReading = Math.max(now, lastReading ?? now);
    return now;
  };

  return {
    begin() {
      if (startedAt === null) startedAt = read();
    },
    observe(event) {
      if (startedAt === null || terminalAt !== null || settled !== null) return;
      if (event.kind !== "text-delta" && event.kind !== "reasoning-delta") return;
      if (event.text.length === 0) return;
      const now = read();
      const channel = event.kind === "text-delta" ? "text" : "reasoning";
      characters[channel] += event.text.length;
      // Estimate over the cumulative text so tiny deltas are not each rounded up.
      const total = estimateTokensForLength(characters[channel]);
      const tokens = total - estimated[channel];
      estimated[channel] = total;
      firstOutputAt ??= now;
      const last = samples.at(-1);
      if (last !== undefined && last.at === now) {
        samples[samples.length - 1] = { at: now, tokens: last.tokens + tokens };
      } else {
        samples.push({ at: now, tokens });
      }
      while (
        samples.length > MAX_LIVE_SAMPLES ||
        (samples[0] !== undefined && samples[0].at <= now - GENERATION_LIVE_WINDOW_MS)
      ) {
        samples.shift();
      }
      if (clockAnomaly || options.sink === undefined) return;
      if (lastLiveAt !== null && now - lastLiveAt < GENERATION_LIVE_INTERVAL_MS) return;
      lastLiveAt = now;
      options.sink.live({
        modelAttemptId: options.modelAttemptId,
        requestId: options.requestId,
        rate: liveGenerationRate(samples, firstOutputAt, now),
      });
    },
    end() {
      if (startedAt !== null && terminalAt === null) terminalAt = read();
    },
    finish(completion, usage) {
      if (settled !== null) return settled.timing;
      if (startedAt === null) {
        settled = { timing: null };
        return null;
      }
      if (terminalAt === null) terminalAt = read();
      const timing = summarizeGeneration({
        modelAttemptId: options.modelAttemptId,
        requestId: options.requestId,
        completion,
        requestStartedAt: startedAt,
        firstOutputAt,
        terminalAt,
        clockAnomaly,
        estimated,
        usage,
      });
      settled = { timing };
      options.sink?.settled(timing);
      return timing;
    },
  };
}

/** Passes a provider stream through unchanged while timing it at receipt. */
export async function* timeProviderStream(
  events: AsyncIterable<NormalizedProviderEvent>,
  recorder: GenerationTimingRecorder,
): AsyncGenerator<NormalizedProviderEvent> {
  recorder.begin();
  try {
    for await (const event of events) {
      recorder.observe(event);
      if (event.kind === "finished" || event.kind === "error") recorder.end();
      yield event;
    }
  } finally {
    recorder.end();
  }
}

export type GenerationActivityEntry =
  | {
      readonly phase: "live";
      readonly turnId: string;
      readonly modelAttemptId: string;
      readonly requestId: string;
      readonly rate: GenerationRate;
    }
  | {
      readonly phase: "final";
      readonly turnId: string;
      readonly timing: GenerationTiming;
    };

/**
 * One executor's latest generation state, for views.
 *
 * Each executor owns its own activity, so a parent's view never includes a
 * child's stream. Nothing here is persisted: the durable fact is the final
 * timing on the attempt receipt.
 */
export type GenerationActivity = {
  current(): GenerationActivityEntry | null;
  /** The listener takes no argument; readers call `current()`. */
  subscribe(listener: () => void): () => void;
  /** A sink bound to one turn's attempts. */
  sinkFor(turnId: string): GenerationTimingSink;
};

export function createGenerationActivity(): GenerationActivity {
  let latest: GenerationActivityEntry | null = null;
  const listeners = new Set<() => void>();
  const publish = (entry: GenerationActivityEntry): void => {
    latest = entry;
    for (const listener of [...listeners]) listener();
  };
  return {
    current: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sinkFor(turnId) {
      return {
        live: (update) => publish({ phase: "live", turnId, ...update }),
        settled: (timing) => publish({ phase: "final", turnId, timing }),
      };
    },
  };
}
