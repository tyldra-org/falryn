/**
 * Words for generation timing.
 *
 * Every surface that shows a rate uses these, so the status line, the
 * transcript and the CLI cannot label the same fact differently. The rate label
 * has a fixed width: a live value changing from 9 to 42 must not move the text
 * beside it. Estimates, live values, partial streams and missing samples are
 * named in words, never by color alone.
 */

import type { GenerationRate, GenerationTiming } from "../../domain/sessions/index.ts";

/** Columns every rate label occupies, including padding. */
export const GENERATION_RATE_LABEL_WIDTH = 35;

export type GenerationRatePhase = "live" | "complete" | "partial";

function rateValue(rate: GenerationRate): string {
  switch (rate.kind) {
    case "measured":
      return String(Math.min(99_999, Math.round(rate.tokensPerSecond)));
    case "unknown":
      return "?";
    case "insufficient-sample":
    case "unavailable":
      return "-";
  }
}

function rateTags(rate: GenerationRate, phase: GenerationRatePhase): string[] {
  const tags: string[] = [];
  if (
    (rate.kind === "measured" || rate.kind === "insufficient-sample") &&
    rate.source === "estimate"
  )
    tags.push("est.");
  if (phase !== "complete") tags.push(phase);
  if (rate.kind === "insufficient-sample") tags.push("low-sample");
  if (rate.kind === "unknown") tags.push("unknown");
  if (rate.kind === "unavailable") tags.push("unavailable");
  return tags;
}

/** A fixed-width label such as `   42 tok/s est. live`. */
export function generationRateLabel(rate: GenerationRate, phase: GenerationRatePhase): string {
  const tags = rateTags(rate, phase);
  const text = `${rateValue(rate).padStart(5)} tok/s${tags.length === 0 ? "" : ` ${tags.join(" ")}`}`;
  return text.padEnd(GENERATION_RATE_LABEL_WIDTH);
}

function durationText(milliseconds: number | null): string {
  if (milliseconds === null) return "unavailable";
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function tokenText(timing: GenerationTiming): string {
  const { output, reasoning, source } = timing.tokens;
  if (source === "unknown" || output === null) return "output tokens unknown";
  const reasoningText = reasoning === null ? "" : `, ${reasoning} reasoning`;
  return `${output} output tokens${reasoningText} (${source})`;
}

/** The expanded detail for one final fact. */
export function generationDetail(timing: GenerationTiming): string {
  return [
    generationRateLabel(timing.rate, timing.completion).trim(),
    `time to first token ${durationText(timing.timeToFirstTokenMs)}`,
    `generation ${durationText(timing.generationMs)}`,
    tokenText(timing),
    `attempt ${timing.modelAttemptId} request ${timing.requestId}`,
  ].join(" · ");
}
