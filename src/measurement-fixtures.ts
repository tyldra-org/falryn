/**
 * How a measured number is recorded.
 *
 * `src/data/measurement.test.ts` established this shape and this module is it,
 * moved out when a second area needed to measure. The rules it carries are the
 * ones that make a performance number mean anything, and they are the same rules
 * whether the quantity is a transaction or a frame:
 *
 * - **Every number carries the platform it was taken on.** A timing without the
 *   machine under it is not a result, and `report` prints the platform line for
 *   each one rather than once at the top, so a copied line still says where it
 *   came from.
 * - **Distributions, never a single sample.** A count, a minimum, a median, a
 *   p95, and a maximum. A mean over a bimodal set is the one summary that hides
 *   contention, which is the shape half of these quantities have.
 * - **A quantity that could not be measured is reported as unmeasured, with its
 *   reason, and then fails.** Never omitted and never zero: an absent number
 *   that reads as a fast number is the failure the whole idea exists to prevent.
 * - **The gate is one declaration.** `MEASURING` is read from
 *   `FALRYN_MEASURE`, which `bun run measure` sets. Every measuring file hangs
 *   its `describe.if` on this constant, so an ordinary `bun test` reports every
 *   one of them as skipped rather than as passed, absent, or slow.
 *
 * This module is test support. It ships in no build — `bun run build` compiles
 * `src/main.ts`, which does not reach it — and only measurement checks import
 * it.
 */

import { cpus, release, totalmem } from "node:os";

/** Set by `bun run measure`. Anything else leaves a measuring file visibly skipped. */
export const MEASURING = process.env.FALRYN_MEASURE === "1";

export type Distribution = {
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

export function milliseconds(nanoseconds: number): number {
  return nanoseconds / 1_000_000;
}

export function rounded(value: number): string {
  return value.toFixed(3);
}

/**
 * Median and spread rather than a mean.
 *
 * A mean over a bimodal set is the one summary that hides contention, which is
 * precisely the shape half of these quantities have.
 */
export function distribution(samplesNs: readonly number[]): Distribution {
  const sorted = [...samplesNs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    minMs: milliseconds(sorted[0] ?? 0),
    medianMs: milliseconds(median),
    p95Ms: milliseconds(sorted[p95Index] ?? 0),
    maxMs: milliseconds(sorted[sorted.length - 1] ?? 0),
  };
}

export function formatDistribution(value: Distribution): string {
  return [
    `samples ${value.count}`,
    `min ${rounded(value.minMs)} ms`,
    `median ${rounded(value.medianMs)} ms`,
    `p95 ${rounded(value.p95Ms)} ms`,
    `max ${rounded(value.maxMs)} ms`,
  ].join(" | ");
}

export function mebibytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(2)} MiB`;
}

/** KiB below a mebibyte, so a 64 KiB read is not reported as `0.06 MiB`. */
export function binarySize(bytes: number): string {
  return bytes < 1_024 * 1_024 ? `${(bytes / 1_024).toFixed(0)} KiB` : mebibytes(bytes);
}

/** The five qualifiers a recorded performance number has to carry. */
export type Measurement = {
  readonly quantity: string;
  readonly against: string;
  readonly dataset: string;
  readonly state: "cold" | "warm" | "cold and warm";
  readonly result: string;
  readonly notes?: readonly string[];
};

export function platformLine(): string {
  const model = cpus()[0]?.model ?? "unknown cpu";
  const cores = cpus().length;
  return [
    `${process.platform} ${process.arch} ${release()}`,
    `${model} (${cores} logical cores)`,
    `${(totalmem() / (1_024 * 1_024 * 1_024)).toFixed(0)} GiB RAM`,
    `Bun ${Bun.version}`,
  ].join(" | ");
}

export function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function report(measurement: Measurement): void {
  write("");
  write(`── ${measurement.quantity} ──`);
  write(`   against   ${measurement.against}`);
  write(`   dataset   ${measurement.dataset}`);
  write(`   state     ${measurement.state}`);
  write(`   platform  ${platformLine()}`);
  write(`   result    ${measurement.result}`);
  for (const note of measurement.notes ?? []) {
    write(`   note      ${note}`);
  }
}

/**
 * Records a quantity that could not be measured, with the reason.
 *
 * Then throws it, so the run that could not measure it fails rather than
 * finishing quietly. A missing number that reads as a fast number is the exact
 * failure this shape exists to prevent.
 */
export function unmeasured(quantity: string, reason: string): never {
  write("");
  write(`── ${quantity} ──`);
  write(`   result    UNMEASURED`);
  write(`   reason    ${reason}`);
  throw new Error(`${quantity} could not be measured: ${reason}`);
}
