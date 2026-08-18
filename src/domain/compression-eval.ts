/**
 * Compression fidelity, reversibility, latency, and token-savings evaluation
 * (#107).
 *
 * Scores already-produced #101 lane observations. It never calls a model,
 * never registers product tools, and never mixes estimated tokens with
 * provider-reported tokens. Reports contain metrics only; they do not echo
 * projection text.
 */

import { z } from "zod";

import { type ContentDigest, contentDigest, isArtifactSensitivity } from "./artifact.ts";
import { type DurationMs, parseDuration } from "./clock.ts";
import {
  EVIDENCE_FIDELITIES,
  type EvidenceFidelity,
  MAX_EVIDENCE_ESTIMATED_TOKENS,
} from "./context-evidence.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const COMPRESSION_EVAL_VERSION = "eval.v1";
export const DEFAULT_EVAL_LATENCY_BUDGET_MS = 1_000;
export const HARD_EVAL_LATENCY_BUDGET_MS = 60_000;
export const MAX_EVAL_OBSERVATIONS = 32;

export const COMPRESSION_EVAL_LANES = [
  "brief",
  "hush",
  "loom",
  "structural",
  "compact-model",
  "history-checkpoint",
] as const;
export type CompressionEvalLane = (typeof COMPRESSION_EVAL_LANES)[number];

export const COMPRESSION_TOKEN_KINDS = ["estimated", "provider-reported"] as const;
export type CompressionTokenKind = (typeof COMPRESSION_TOKEN_KINDS)[number];

export const COMPRESSION_RECOVERY_KINDS = ["exact-source", "expansion", "none"] as const;
export type CompressionRecoveryKind = (typeof COMPRESSION_RECOVERY_KINDS)[number];

export const COMPRESSION_FIDELITY_VERDICTS = ["faithful", "violation"] as const;
export type CompressionFidelityVerdict = (typeof COMPRESSION_FIDELITY_VERDICTS)[number];

export const COMPRESSION_LATENCY_VERDICTS = ["within-budget", "over-budget"] as const;
export type CompressionLatencyVerdict = (typeof COMPRESSION_LATENCY_VERDICTS)[number];

export type CompressionEvalErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "secret"
  | "empty"
  | "cancelled"
  | "timed-out"
  | "fidelity-violation"
  | "irreversible"
  | "digest-mismatch"
  | "mixed-token-kinds"
  | "stale-cache";

export type CompressionEvalError = {
  readonly kind: "compression-eval";
  readonly code: CompressionEvalErrorCode;
  readonly field: string | null;
};

export type CompressionEvalInput = {
  readonly lane?: unknown;
  readonly fidelity?: unknown;
  readonly claimsExact?: unknown;
  readonly complete?: unknown;
  readonly sourceBytes?: unknown;
  readonly reducedBytes?: unknown;
  readonly overheadBytes?: unknown;
  readonly originalDigest?: unknown;
  readonly expansionDigest?: unknown;
  readonly tokenKind?: unknown;
  readonly sourceTokens?: unknown;
  readonly reducedTokens?: unknown;
  readonly overheadTokens?: unknown;
  readonly latencyMs?: unknown;
  readonly latencyBudgetMs?: unknown;
  readonly sourceGeneration?: unknown;
  readonly cachedGeneration?: unknown;
  readonly sensitivity?: unknown;
  readonly cancelled?: unknown;
  readonly timedOut?: unknown;
};

export type CompressionEvalResult = {
  readonly strategyVersion: typeof COMPRESSION_EVAL_VERSION;
  readonly lane: CompressionEvalLane;
  readonly fidelity: EvidenceFidelity;
  readonly fidelityVerdict: CompressionFidelityVerdict;
  readonly claimsExact: boolean;
  readonly reversible: true;
  readonly recovery: Exclude<CompressionRecoveryKind, "none">;
  readonly originalDigest: ContentDigest;
  readonly expansionDigest: ContentDigest;
  readonly tokenKind: CompressionTokenKind;
  readonly sourceTokens: number;
  readonly reducedTokens: number;
  readonly overheadTokens: number;
  readonly netTokens: number;
  readonly sourceBytes: number;
  readonly reducedBytes: number;
  readonly overheadBytes: number;
  readonly netBytes: number;
  readonly savings: boolean;
  readonly latencyMs: DurationMs;
  readonly latencyBudgetMs: DurationMs;
  readonly latencyVerdict: CompressionLatencyVerdict;
};

export type CompressionEvalRunInput = {
  readonly observations?: unknown;
  readonly cancelled?: unknown;
};

export type CompressionEvalRun = {
  readonly strategyVersion: typeof COMPRESSION_EVAL_VERSION;
  readonly tokenKind: CompressionTokenKind;
  readonly observationCount: number;
  readonly netTokens: number;
  readonly netBytes: number;
  readonly savings: boolean;
  readonly results: readonly CompressionEvalResult[];
};

const laneSchema = z.enum(COMPRESSION_EVAL_LANES);
const fidelitySchema = z.enum(EVIDENCE_FIDELITIES);
const tokenKindSchema = z.enum(COMPRESSION_TOKEN_KINDS);

function evalError(code: CompressionEvalErrorCode, field: string | null): CompressionEvalError {
  return { kind: "compression-eval", code, field };
}

export function describeCompressionEvalError(error: CompressionEvalError): string {
  const field = error.field === null ? "eval" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return `secret ${field}`;
    case "empty":
      return `empty ${field}`;
    case "cancelled":
      return `cancelled ${field}`;
    case "timed-out":
      return `timed-out ${field}`;
    case "fidelity-violation":
      return `fidelity-violation ${field}`;
    case "irreversible":
      return `irreversible ${field}`;
    case "digest-mismatch":
      return `digest-mismatch ${field}`;
    case "mixed-token-kinds":
      return `mixed-token-kinds ${field}`;
    case "stale-cache":
      return `stale-cache ${field}`;
    default:
      return assertNever(error.code, "unhandled compression eval error");
  }
}

function parseNonNegativeInt(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
): Result<number, CompressionEvalError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return err(evalError("malformed", field));
  }
  if (value > maximum) {
    return err(evalError("oversized", field));
  }
  return ok(value);
}

function parseBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): Result<boolean, CompressionEvalError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "boolean") {
    return err(evalError("malformed", field));
  }
  return ok(value);
}

function parseOptionalDigest(
  value: unknown,
  field: string,
): Result<ContentDigest | null, CompressionEvalError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  const parsed = contentDigest.parse(value);
  if (!parsed.ok) {
    return err(evalError("malformed", field));
  }
  return ok(parsed.value);
}

function exactAllowed(fidelity: EvidenceFidelity): boolean {
  switch (fidelity) {
    case "exact-source":
      return true;
    case "bounded-excerpt":
    case "deterministic-transform":
    case "extractive-summary":
    case "lossy-synthesis":
      return false;
    default:
      return assertNever(fidelity, "unhandled evidence fidelity");
  }
}

function recoveryFor(fidelity: EvidenceFidelity): Exclude<CompressionRecoveryKind, "none"> {
  switch (fidelity) {
    case "exact-source":
      return "exact-source";
    case "bounded-excerpt":
    case "deterministic-transform":
    case "extractive-summary":
    case "lossy-synthesis":
      return "expansion";
    default:
      return assertNever(fidelity, "unhandled evidence fidelity");
  }
}

/**
 * Score one compression-lane observation.
 *
 * Cancelled and restricted input fail closed. Lossy or extractive projections
 * that claim exact-source fail. Missing or disagreeing expansion digests fail.
 * Latency over the declared budget is `timed-out`. Savings subtract overhead
 * and keep one token kind.
 */
export function evaluateCompression(
  input: CompressionEvalInput,
): Result<CompressionEvalResult, CompressionEvalError> {
  const cancelled = parseBoolean(input.cancelled, "cancelled", false);
  if (!cancelled.ok) {
    return cancelled;
  }
  if (cancelled.value) {
    return err(evalError("cancelled", "signal"));
  }
  const timedOut = parseBoolean(input.timedOut, "timedOut", false);
  if (!timedOut.ok) {
    return timedOut;
  }
  if (timedOut.value) {
    return err(evalError("timed-out", "latencyMs"));
  }

  const laneParsed = laneSchema.safeParse(input.lane);
  if (!laneParsed.success) {
    return err(evalError(input.lane === undefined ? "empty" : "malformed", "lane"));
  }
  const fidelityParsed = fidelitySchema.safeParse(input.fidelity);
  if (!fidelityParsed.success) {
    return err(evalError(input.fidelity === undefined ? "empty" : "malformed", "fidelity"));
  }
  const tokenKindParsed = tokenKindSchema.safeParse(input.tokenKind);
  if (!tokenKindParsed.success) {
    return err(evalError(input.tokenKind === undefined ? "empty" : "malformed", "tokenKind"));
  }

  const claimsExact = parseBoolean(input.claimsExact, "claimsExact", false);
  if (!claimsExact.ok) {
    return claimsExact;
  }
  const complete = parseBoolean(input.complete, "complete", false);
  if (!complete.ok) {
    return complete;
  }

  const sensitivity = input.sensitivity === undefined ? "user-content" : input.sensitivity;
  if (!isArtifactSensitivity(sensitivity)) {
    return err(evalError("malformed", "sensitivity"));
  }
  if (sensitivity === "restricted") {
    return err(evalError("secret", "sensitivity"));
  }

  const sourceBytes = parseNonNegativeInt(
    input.sourceBytes,
    "sourceBytes",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS * 8,
  );
  if (!sourceBytes.ok) {
    return sourceBytes;
  }
  const reducedBytes = parseNonNegativeInt(
    input.reducedBytes,
    "reducedBytes",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS * 8,
  );
  if (!reducedBytes.ok) {
    return reducedBytes;
  }
  const overheadBytes = parseNonNegativeInt(
    input.overheadBytes,
    "overheadBytes",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS * 8,
  );
  if (!overheadBytes.ok) {
    return overheadBytes;
  }
  const sourceTokens = parseNonNegativeInt(
    input.sourceTokens,
    "sourceTokens",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS,
  );
  if (!sourceTokens.ok) {
    return sourceTokens;
  }
  const reducedTokens = parseNonNegativeInt(
    input.reducedTokens,
    "reducedTokens",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS,
  );
  if (!reducedTokens.ok) {
    return reducedTokens;
  }
  const overheadTokens = parseNonNegativeInt(
    input.overheadTokens,
    "overheadTokens",
    0,
    MAX_EVIDENCE_ESTIMATED_TOKENS,
  );
  if (!overheadTokens.ok) {
    return overheadTokens;
  }

  const latency = parseDuration(input.latencyMs ?? 0);
  if (!latency.ok) {
    return err(evalError("malformed", "latencyMs"));
  }
  const budget = parseDuration(input.latencyBudgetMs ?? DEFAULT_EVAL_LATENCY_BUDGET_MS);
  if (!budget.ok) {
    return err(evalError("malformed", "latencyBudgetMs"));
  }
  if (budget.value > HARD_EVAL_LATENCY_BUDGET_MS) {
    return err(evalError("oversized", "latencyBudgetMs"));
  }
  if (latency.value > budget.value) {
    return err(evalError("timed-out", "latencyMs"));
  }

  const sourceGeneration = parseNonNegativeInt(
    input.sourceGeneration,
    "sourceGeneration",
    0,
    1_000_000_000,
  );
  if (!sourceGeneration.ok) {
    return sourceGeneration;
  }
  const cachedGeneration = parseNonNegativeInt(
    input.cachedGeneration,
    "cachedGeneration",
    sourceGeneration.value,
    1_000_000_000,
  );
  if (!cachedGeneration.ok) {
    return cachedGeneration;
  }
  if (cachedGeneration.value !== sourceGeneration.value) {
    return err(evalError("stale-cache", "cachedGeneration"));
  }

  const originalDigest = parseOptionalDigest(input.originalDigest, "originalDigest");
  if (!originalDigest.ok) {
    return originalDigest;
  }
  const expansionDigest = parseOptionalDigest(input.expansionDigest, "expansionDigest");
  if (!expansionDigest.ok) {
    return expansionDigest;
  }
  if (originalDigest.value === null || expansionDigest.value === null) {
    return err(evalError("irreversible", "expansionDigest"));
  }
  if (originalDigest.value !== expansionDigest.value) {
    return err(evalError("digest-mismatch", "expansionDigest"));
  }

  const fidelity = fidelityParsed.data;
  if (claimsExact.value && (!exactAllowed(fidelity) || !complete.value)) {
    return err(evalError("fidelity-violation", "claimsExact"));
  }
  if (fidelity === "exact-source" && !claimsExact.value) {
    return err(evalError("fidelity-violation", "fidelity"));
  }

  const netBytes = sourceBytes.value - reducedBytes.value - overheadBytes.value;
  const netTokens = sourceTokens.value - reducedTokens.value - overheadTokens.value;
  return ok({
    strategyVersion: COMPRESSION_EVAL_VERSION,
    lane: laneParsed.data,
    fidelity,
    fidelityVerdict: "faithful",
    claimsExact: claimsExact.value,
    reversible: true,
    recovery: recoveryFor(fidelity),
    originalDigest: originalDigest.value,
    expansionDigest: expansionDigest.value,
    tokenKind: tokenKindParsed.data,
    sourceTokens: sourceTokens.value,
    reducedTokens: reducedTokens.value,
    overheadTokens: overheadTokens.value,
    netTokens,
    sourceBytes: sourceBytes.value,
    reducedBytes: reducedBytes.value,
    overheadBytes: overheadBytes.value,
    netBytes,
    savings: netTokens > 0 && netBytes > 0,
    latencyMs: latency.value,
    latencyBudgetMs: budget.value,
    latencyVerdict: "within-budget",
  });
}

/**
 * Score a same-kind batch and total lifetime savings.
 *
 * Mixing estimated with provider-reported tokens is refused. An empty batch is
 * refused. A second token kind anywhere in the run fails closed.
 */
export function evaluateCompressionRun(
  input: CompressionEvalRunInput,
): Result<CompressionEvalRun, CompressionEvalError> {
  const cancelled = parseBoolean(input.cancelled, "cancelled", false);
  if (!cancelled.ok) {
    return cancelled;
  }
  if (cancelled.value) {
    return err(evalError("cancelled", "signal"));
  }
  if (!Array.isArray(input.observations)) {
    return err(evalError("malformed", "observations"));
  }
  if (input.observations.length === 0) {
    return err(evalError("empty", "observations"));
  }
  if (input.observations.length > MAX_EVAL_OBSERVATIONS) {
    return err(evalError("oversized", "observations"));
  }

  const results: CompressionEvalResult[] = [];
  let tokenKind: CompressionTokenKind | null = null;
  let netTokens = 0;
  let netBytes = 0;
  for (const observation of input.observations) {
    if (observation === null || typeof observation !== "object") {
      return err(evalError("malformed", "observations"));
    }
    const evaluated = evaluateCompression(observation);
    if (!evaluated.ok) {
      return evaluated;
    }
    if (tokenKind === null) {
      tokenKind = evaluated.value.tokenKind;
    } else if (tokenKind !== evaluated.value.tokenKind) {
      return err(evalError("mixed-token-kinds", "tokenKind"));
    }
    netTokens += evaluated.value.netTokens;
    netBytes += evaluated.value.netBytes;
    results.push(evaluated.value);
  }
  if (tokenKind === null) {
    return err(evalError("empty", "observations"));
  }
  return ok({
    strategyVersion: COMPRESSION_EVAL_VERSION,
    tokenKind,
    observationCount: results.length,
    netTokens,
    netBytes,
    savings: netTokens > 0 && netBytes > 0,
    results,
  });
}
