/**
 * Application boundary for compression evaluation (#107).
 *
 * Maps lane results onto eval observations, refuses cancelled calls, and never
 * puts projection text on the report. Does not register product tools or call
 * a live compact model.
 */

import {
  type CompactReduceResult,
  type CompressionEvalError,
  type CompressionEvalInput,
  type CompressionEvalResult,
  type CompressionEvalRun,
  type CompressionTokenKind,
  err,
  evaluateCompression,
  evaluateCompressionRun,
  type HistoryCheckpoint,
  type Result,
  type StructuralReduceResult,
} from "../domain/index.ts";

export type CompressionEvalPort = {
  evaluate(
    input: CompressionEvalInput,
    signal?: AbortSignal,
  ): Result<CompressionEvalResult, CompressionEvalError | CompressionEvalPortError>;
  evaluateRun(
    observations: readonly CompressionEvalInput[],
    signal?: AbortSignal,
  ): Result<CompressionEvalRun, CompressionEvalError | CompressionEvalPortError>;
};

export type CompressionEvalPortError = {
  readonly kind: "compression-eval-port";
  readonly code: "cancelled";
  readonly field: "signal";
};

function tokensForBytes(bytes: number): number {
  return Math.max(0, Math.ceil(bytes / 4));
}

export function observationFromCompact(
  result: CompactReduceResult,
  extras: {
    readonly latencyMs: number;
    readonly latencyBudgetMs?: number;
    readonly tokenKind?: CompressionTokenKind;
  },
): CompressionEvalInput {
  const digest = result.expansion?.digest;
  return {
    lane: "compact-model",
    fidelity: result.evidenceFidelity,
    claimsExact: result.claimsExact,
    complete: result.complete,
    sourceBytes: result.sourceBytes,
    reducedBytes: result.reducedBytes,
    overheadBytes: 0,
    originalDigest: digest,
    expansionDigest: digest,
    tokenKind: extras.tokenKind ?? "estimated",
    sourceTokens: tokensForBytes(result.sourceBytes),
    reducedTokens: tokensForBytes(result.reducedBytes),
    overheadTokens: 0,
    latencyMs: extras.latencyMs,
    ...(extras.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: extras.latencyBudgetMs }),
  };
}

export function observationFromStructural(
  result: StructuralReduceResult,
  extras: {
    readonly latencyMs: number;
    readonly latencyBudgetMs?: number;
    readonly tokenKind?: CompressionTokenKind;
  },
): CompressionEvalInput {
  const digest = result.expansion?.digest;
  return {
    lane: "structural",
    fidelity: result.evidenceFidelity,
    claimsExact: result.claimsExact,
    complete: result.complete,
    sourceBytes: result.sourceBytes,
    reducedBytes: result.reducedBytes,
    overheadBytes: 0,
    originalDigest: digest,
    expansionDigest: digest,
    tokenKind: extras.tokenKind ?? "estimated",
    sourceTokens: tokensForBytes(result.sourceBytes),
    reducedTokens: tokensForBytes(result.reducedBytes),
    overheadTokens: 0,
    latencyMs: extras.latencyMs,
    ...(extras.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: extras.latencyBudgetMs }),
  };
}

export function observationFromHistoryCheckpoint(
  checkpoint: HistoryCheckpoint,
  extras: {
    readonly latencyMs: number;
    readonly latencyBudgetMs?: number;
    readonly tokenKind?: CompressionTokenKind;
  },
): CompressionEvalInput | null {
  if (checkpoint.folded === null) {
    return null;
  }
  return observationFromCompact(checkpoint.folded, extras);
}

export function createCompressionEvaluator(): CompressionEvalPort {
  return {
    evaluate(input, signal) {
      if (signal?.aborted === true) {
        return err({ kind: "compression-eval-port", code: "cancelled", field: "signal" });
      }
      return evaluateCompression(input);
    },
    evaluateRun(observations, signal) {
      if (signal?.aborted === true) {
        return err({ kind: "compression-eval-port", code: "cancelled", field: "signal" });
      }
      return evaluateCompressionRun({ observations });
    },
  };
}
