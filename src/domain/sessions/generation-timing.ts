/**
 * Generation timing for one provider request stream.
 *
 * One model attempt can issue several provider requests around tool calls.
 * Each request stream owns its own timing, so tool execution, confirmation,
 * hooks, queueing and retry backoff fall between streams rather than inside a
 * generation window.
 *
 * Times are `ClockPort` readings taken when the stream consumer receives an
 * event, not when anything renders. A reading that goes backwards makes the
 * timing unavailable instead of producing a negative or inflated rate. Token
 * counts prefer provider-reported usage; otherwise they are estimates over the
 * received delta text, and missing usage without text stays unknown, never zero.
 */
import { z } from "zod";

export const GENERATION_TIMING_VERSION = 1;
/** Trailing window for the live rate. */
export const GENERATION_LIVE_WINDOW_MS = 2_000;
/** Minimum spacing between live rate updates (at most four per second). */
export const GENERATION_LIVE_INTERVAL_MS = 250;
/** Below this duration a rate is reported as an insufficient sample. */
export const GENERATION_MIN_SAMPLE_MS = 250;
/** Below this token count a rate is reported as an insufficient sample. */
export const GENERATION_MIN_SAMPLE_TOKENS = 8;
/** Matches the per-task provider request ceiling. */
export const MAX_GENERATION_REQUESTS = 64;

export type GenerationTokenSource = "provider-reported" | "estimate" | "unknown";

export type GenerationRate =
  | {
      readonly kind: "measured";
      readonly tokensPerSecond: number;
      readonly source: "provider-reported" | "estimate";
    }
  | {
      readonly kind: "insufficient-sample";
      readonly source: "provider-reported" | "estimate";
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable"; readonly reason: "clock-anomaly" };

const identity = z.string().min(1).max(256);
const milliseconds = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenCount = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measuredSource = z.enum(["provider-reported", "estimate"]);

export const generationRateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("measured"),
    tokensPerSecond: z.number().nonnegative().finite(),
    source: measuredSource,
  }),
  z.strictObject({ kind: z.literal("insufficient-sample"), source: measuredSource }),
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("unavailable"), reason: z.literal("clock-anomaly") }),
]);

export const generationTimingSchema = z.strictObject({
  version: z.literal(GENERATION_TIMING_VERSION),
  modelAttemptId: identity,
  requestId: identity,
  /** `partial` when the stream ended without a normal finish (cancelled, failed, cut off). */
  completion: z.enum(["complete", "partial"]),
  timeToFirstTokenMs: milliseconds.nullable(),
  /** First output delta to terminal; null when no output delta arrived. */
  generationMs: milliseconds.nullable(),
  tokens: z.strictObject({
    source: z.enum(["provider-reported", "estimate", "unknown"]),
    /** Output tokens as the adapter reported them, or the text+reasoning estimate. */
    output: tokenCount.nullable(),
    /** Reported separately only when the provider or the stream distinguishes it. */
    reasoning: tokenCount.nullable(),
  }),
  rate: generationRateSchema,
});
export type GenerationTiming = z.infer<typeof generationTimingSchema>;

/** Final timing facts for one model attempt, persisted on its completion event. */
export const generationTimingRecordSchema = z
  .strictObject({
    version: z.literal(GENERATION_TIMING_VERSION),
    requests: z.array(generationTimingSchema).max(MAX_GENERATION_REQUESTS),
  })
  .refine(
    (record) =>
      new Set(record.requests.map((entry) => entry.requestId)).size === record.requests.length,
    "Generation timing request identities must be unique.",
  );
export type GenerationTimingRecord = z.infer<typeof generationTimingRecordSchema>;

/** Usage fields the timing needs; structurally compatible with provider usage. */
export type GenerationUsage = {
  readonly provenance: "provider-reported" | "estimate" | "unknown";
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
};

export type GenerationObservation = {
  readonly modelAttemptId: string;
  readonly requestId: string;
  readonly completion: "complete" | "partial";
  readonly requestStartedAt: number;
  readonly firstOutputAt: number | null;
  readonly terminalAt: number;
  /** True when any clock reading went backwards during the stream. */
  readonly clockAnomaly: boolean;
  /** Estimated tokens over received delta text. */
  readonly estimated: { readonly text: number; readonly reasoning: number };
  readonly usage: GenerationUsage | null;
};

export type GenerationDeltaSample = {
  readonly at: number;
  readonly tokens: number;
};

function roundRate(tokens: number, spanMs: number): number {
  return Math.round((tokens * 10_000) / spanMs) / 10;
}

function rateFor(
  tokens: number,
  spanMs: number | null,
  source: "provider-reported" | "estimate",
): GenerationRate {
  if (spanMs === null || spanMs < GENERATION_MIN_SAMPLE_MS || tokens < GENERATION_MIN_SAMPLE_TOKENS)
    return { kind: "insufficient-sample", source };
  return { kind: "measured", tokensPerSecond: roundRate(tokens, spanMs), source };
}

function reportedCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Derives the final timing fact. Pure: the same observation yields the same fact. */
export function summarizeGeneration(observation: GenerationObservation): GenerationTiming {
  const reportedOutput =
    observation.usage?.provenance === "provider-reported"
      ? reportedCount(observation.usage.outputTokens)
      : null;
  const estimatedOutput = observation.estimated.text + observation.estimated.reasoning;
  const tokens: GenerationTiming["tokens"] =
    reportedOutput !== null
      ? {
          source: "provider-reported",
          output: reportedOutput,
          reasoning: reportedCount(observation.usage?.reasoningTokens),
        }
      : estimatedOutput > 0
        ? {
            source: "estimate",
            output: estimatedOutput,
            reasoning: observation.estimated.reasoning > 0 ? observation.estimated.reasoning : null,
          }
        : { source: "unknown", output: null, reasoning: null };
  const first = observation.firstOutputAt;
  const timed = !observation.clockAnomaly;
  const generationMs = timed && first !== null ? observation.terminalAt - first : null;
  const rate: GenerationRate = observation.clockAnomaly
    ? { kind: "unavailable", reason: "clock-anomaly" }
    : tokens.source === "unknown" || tokens.output === null
      ? { kind: "unknown" }
      : rateFor(tokens.output, generationMs, tokens.source);
  return {
    version: GENERATION_TIMING_VERSION,
    modelAttemptId: observation.modelAttemptId,
    requestId: observation.requestId,
    completion: observation.completion,
    timeToFirstTokenMs: timed && first !== null ? first - observation.requestStartedAt : null,
    generationMs,
    tokens,
    rate,
  };
}

/**
 * Live rate over the trailing window ending at `now`.
 *
 * The window starts at the later of `now - GENERATION_LIVE_WINDOW_MS` and the
 * first output delta, so a young stream is not diluted by time before output.
 * Live counts are always estimates: provider usage normally arrives at the end.
 */
export function liveGenerationRate(
  samples: readonly GenerationDeltaSample[],
  firstOutputAt: number | null,
  now: number,
): GenerationRate {
  if (firstOutputAt === null || now < firstOutputAt)
    return { kind: "insufficient-sample", source: "estimate" };
  const floor = now - GENERATION_LIVE_WINDOW_MS;
  const windowStart = Math.max(floor, firstOutputAt);
  let tokens = 0;
  for (const sample of samples) {
    if (sample.at > floor && sample.at >= windowStart && sample.at <= now) tokens += sample.tokens;
  }
  return rateFor(tokens, now - windowStart, "estimate");
}
