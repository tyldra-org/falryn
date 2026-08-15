/**
 * Context-engine token, byte, item, latency, and sensitivity budgets (#83).
 *
 * Output and tool-framing tokens are reserved before any evidence is filled.
 * Accounting consumes admitted #82 candidates in caller order. It does not
 * rank, compose packs, narrow excerpts, or rewrite payloads. Under pressure it
 * removes duplicates, defers expansion-bearing items, and drops extractive or
 * lossy projections before omitting overflow. Estimated tokens are never mixed
 * with provider-reported counts.
 */

import type { ArtifactSensitivity } from "./artifact.ts";
import { type DurationMs, duration, parseDuration } from "./clock.ts";
import {
  EVIDENCE_SOURCE_KINDS,
  type EvidenceCandidate,
  type EvidenceSourceKind,
  MAX_EVIDENCE_BATCH,
  MAX_EVIDENCE_ESTIMATED_TOKENS,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import type { EvidenceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_CONTEXT_MAX_TOTAL_TOKENS = 32_768;
export const DEFAULT_CONTEXT_MAX_TOTAL_BYTES = 256 * 1_024;
export const DEFAULT_CONTEXT_MAX_ITEMS = 32;
export const DEFAULT_CONTEXT_MAX_LATENCY_MS = 10_000;
export const DEFAULT_CONTEXT_MAX_ITEM_TOKENS = 8_192;
export const DEFAULT_CONTEXT_MAX_ITEM_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const DEFAULT_CONTEXT_RESERVED_OUTPUT_TOKENS = 4_096;
export const DEFAULT_CONTEXT_RESERVED_TOOL_FRAMING_TOKENS = 2_048;

export const HARD_CONTEXT_MAX_TOTAL_TOKENS = 128_000;
export const HARD_CONTEXT_MAX_TOTAL_BYTES = 1_048_576;
export const HARD_CONTEXT_MAX_ITEMS = MAX_EVIDENCE_BATCH;
export const HARD_CONTEXT_MAX_LATENCY_MS = 60_000;

export const CONTEXT_BUDGET_DESTINATIONS = ["local", "model", "support"] as const;
export type ContextBudgetDestination = (typeof CONTEXT_BUDGET_DESTINATIONS)[number];

export const CONTEXT_PRESSURE_KINDS = ["token", "byte", "item", "latency", "sensitivity"] as const;
export type ContextPressureKind = (typeof CONTEXT_PRESSURE_KINDS)[number];

export const CONTEXT_PRESSURE_ACTIONS = [
  "remove-duplication",
  "narrow-excerpts",
  "defer-retrievable",
  "prefer-deterministic",
] as const;
export type ContextPressureAction = (typeof CONTEXT_PRESSURE_ACTIONS)[number];

export const CONTEXT_BUDGET_OMISSION_REASONS = [
  "secret",
  "destination-ineligible",
  "item-limit",
  "duplicate",
  "deferred-retrievable",
  "lossy-projection",
  "source-class-limit",
  "budget-exceeded",
  "latency-limit",
] as const;
export type ContextBudgetOmissionReason = (typeof CONTEXT_BUDGET_OMISSION_REASONS)[number];

export const INSUFFICIENT_CONTEXT_RECOVERIES = [
  "narrower-task",
  "different-model",
  "artifact-expansion",
  "additional-retrieval",
] as const;
export type InsufficientContextRecovery = (typeof INSUFFICIENT_CONTEXT_RECOVERIES)[number];

export type ContextBudgetErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "reservation-exceeds-total";

export type ContextBudgetError = {
  readonly kind: "context-budget";
  readonly code: ContextBudgetErrorCode;
  readonly field: string | null;
};

export type ContextSourceClassLimit = {
  readonly maxItems: number | null;
  readonly maxTokens: number | null;
  readonly maxBytes: number | null;
};

export type ContextBudgetProfile = {
  readonly maxTotalTokens: number;
  readonly maxTotalBytes: number;
  readonly maxItems: number;
  readonly maxLatencyMs: DurationMs;
  readonly maxItemTokens: number;
  readonly maxItemBytes: number;
  readonly reservedOutputTokens: number;
  readonly reservedToolFramingTokens: number;
  readonly destination: ContextBudgetDestination;
  readonly sourceClass: Readonly<Partial<Record<EvidenceSourceKind, ContextSourceClassLimit>>>;
};

export type ContextSourceClassLimitInput = {
  readonly maxItems?: number | null;
  readonly maxTokens?: number | null;
  readonly maxBytes?: number | null;
};

export type ContextBudgetProfileInput = {
  readonly maxTotalTokens?: number;
  readonly maxTotalBytes?: number;
  readonly maxItems?: number;
  readonly maxLatencyMs?: number;
  readonly maxItemTokens?: number;
  readonly maxItemBytes?: number;
  readonly reservedOutputTokens?: number;
  readonly reservedToolFramingTokens?: number;
  readonly destination?: string;
  readonly sourceClass?: Readonly<Partial<Record<string, ContextSourceClassLimitInput>>>;
};

export type ContextBudgetCharge = {
  readonly candidate: EvidenceCandidate;
  readonly latencyMs?: number;
  readonly required?: boolean;
};

export type ContextBudgetOmission = {
  readonly id: EvidenceId;
  readonly reason: ContextBudgetOmissionReason;
};

export type InsufficientContext = {
  readonly kind: "insufficient-context";
  readonly recoveries: readonly InsufficientContextRecovery[];
};

export type ContextBudgetPlan = {
  readonly profile: ContextBudgetProfile;
  readonly reservedOutputTokens: number;
  readonly reservedToolFramingTokens: number;
  readonly remainingTokens: number;
  readonly remainingBytes: number;
  readonly remainingItems: number;
  readonly remainingLatencyMs: DurationMs;
  readonly included: readonly EvidenceCandidate[];
  readonly omitted: readonly ContextBudgetOmission[];
  readonly pressure: readonly ContextPressureKind[];
  readonly appliedActions: readonly ContextPressureAction[];
  readonly insufficient: InsufficientContext | null;
};

type ResolvedCharge = {
  readonly candidate: EvidenceCandidate;
  readonly latencyMs: DurationMs;
  readonly required: boolean;
  readonly bytes: number;
};

function budgetError(code: ContextBudgetErrorCode, field: string | null): ContextBudgetError {
  return { kind: "context-budget", code, field };
}

function parseBound(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
  minimum = 0,
): Result<number, ContextBudgetError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return err(budgetError("malformed", field));
  }
  if (value > maximum) {
    return err(budgetError("oversized", field));
  }
  return ok(value);
}

function parseOptionalBound(
  value: unknown,
  field: string,
  maximum: number,
): Result<number | null, ContextBudgetError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  return parseBound(value, field, 0, maximum, 0);
}

function parseSourceClass(
  value: ContextBudgetProfileInput["sourceClass"],
): Result<ContextBudgetProfile["sourceClass"], ContextBudgetError> {
  if (value === undefined) {
    return ok({});
  }
  const resolved: Partial<Record<EvidenceSourceKind, ContextSourceClassLimit>> = {};
  for (const [rawKind, limits] of Object.entries(value)) {
    if (!(EVIDENCE_SOURCE_KINDS as readonly string[]).includes(rawKind)) {
      return err(budgetError("unsupported", "sourceClass"));
    }
    const kind = rawKind as EvidenceSourceKind;
    const maxItems = parseOptionalBound(
      limits?.maxItems,
      "sourceClass.maxItems",
      HARD_CONTEXT_MAX_ITEMS,
    );
    if (!maxItems.ok) {
      return maxItems;
    }
    const maxTokens = parseOptionalBound(
      limits?.maxTokens,
      "sourceClass.maxTokens",
      HARD_CONTEXT_MAX_TOTAL_TOKENS,
    );
    if (!maxTokens.ok) {
      return maxTokens;
    }
    const maxBytes = parseOptionalBound(
      limits?.maxBytes,
      "sourceClass.maxBytes",
      HARD_CONTEXT_MAX_TOTAL_BYTES,
    );
    if (!maxBytes.ok) {
      return maxBytes;
    }
    resolved[kind] = {
      maxItems: maxItems.value,
      maxTokens: maxTokens.value,
      maxBytes: maxBytes.value,
    };
  }
  return ok(resolved);
}

export function parseContextBudgetProfile(
  input: ContextBudgetProfileInput = {},
): Result<ContextBudgetProfile, ContextBudgetError> {
  const maxTotalTokens = parseBound(
    input.maxTotalTokens,
    "maxTotalTokens",
    DEFAULT_CONTEXT_MAX_TOTAL_TOKENS,
    HARD_CONTEXT_MAX_TOTAL_TOKENS,
    1,
  );
  if (!maxTotalTokens.ok) {
    return maxTotalTokens;
  }
  const maxTotalBytes = parseBound(
    input.maxTotalBytes,
    "maxTotalBytes",
    DEFAULT_CONTEXT_MAX_TOTAL_BYTES,
    HARD_CONTEXT_MAX_TOTAL_BYTES,
    1,
  );
  if (!maxTotalBytes.ok) {
    return maxTotalBytes;
  }
  const maxItems = parseBound(
    input.maxItems,
    "maxItems",
    DEFAULT_CONTEXT_MAX_ITEMS,
    HARD_CONTEXT_MAX_ITEMS,
    1,
  );
  if (!maxItems.ok) {
    return maxItems;
  }
  const latencyRaw = parseBound(
    input.maxLatencyMs,
    "maxLatencyMs",
    DEFAULT_CONTEXT_MAX_LATENCY_MS,
    HARD_CONTEXT_MAX_LATENCY_MS,
    0,
  );
  if (!latencyRaw.ok) {
    return latencyRaw;
  }
  const maxItemTokens = parseBound(
    input.maxItemTokens,
    "maxItemTokens",
    DEFAULT_CONTEXT_MAX_ITEM_TOKENS,
    MAX_EVIDENCE_ESTIMATED_TOKENS,
    1,
  );
  if (!maxItemTokens.ok) {
    return maxItemTokens;
  }
  const maxItemBytes = parseBound(
    input.maxItemBytes,
    "maxItemBytes",
    DEFAULT_CONTEXT_MAX_ITEM_BYTES,
    MAX_EVIDENCE_INLINE_BYTES,
    1,
  );
  if (!maxItemBytes.ok) {
    return maxItemBytes;
  }
  const reservedOutputTokens = parseBound(
    input.reservedOutputTokens,
    "reservedOutputTokens",
    DEFAULT_CONTEXT_RESERVED_OUTPUT_TOKENS,
    HARD_CONTEXT_MAX_TOTAL_TOKENS,
    0,
  );
  if (!reservedOutputTokens.ok) {
    return reservedOutputTokens;
  }
  const reservedToolFramingTokens = parseBound(
    input.reservedToolFramingTokens,
    "reservedToolFramingTokens",
    DEFAULT_CONTEXT_RESERVED_TOOL_FRAMING_TOKENS,
    HARD_CONTEXT_MAX_TOTAL_TOKENS,
    0,
  );
  if (!reservedToolFramingTokens.ok) {
    return reservedToolFramingTokens;
  }

  let destination: ContextBudgetDestination = "model";
  if (input.destination !== undefined) {
    if (typeof input.destination !== "string") {
      return err(budgetError("malformed", "destination"));
    }
    if (!(CONTEXT_BUDGET_DESTINATIONS as readonly string[]).includes(input.destination)) {
      return err(budgetError("unsupported", "destination"));
    }
    destination = input.destination as ContextBudgetDestination;
  }

  const sourceClass = parseSourceClass(input.sourceClass);
  if (!sourceClass.ok) {
    return sourceClass;
  }

  if (reservedOutputTokens.value + reservedToolFramingTokens.value > maxTotalTokens.value) {
    return err(budgetError("reservation-exceeds-total", "reservedOutputTokens"));
  }

  return ok({
    maxTotalTokens: maxTotalTokens.value,
    maxTotalBytes: maxTotalBytes.value,
    maxItems: maxItems.value,
    maxLatencyMs: duration(latencyRaw.value),
    maxItemTokens: Math.min(maxItemTokens.value, maxTotalTokens.value),
    maxItemBytes: Math.min(maxItemBytes.value, maxTotalBytes.value),
    reservedOutputTokens: reservedOutputTokens.value,
    reservedToolFramingTokens: reservedToolFramingTokens.value,
    destination,
    sourceClass: sourceClass.value,
  });
}

export function describeContextBudgetError(error: ContextBudgetError): string {
  const field = error.field === null ? "budget" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "reservation-exceeds-total":
      return "reservation exceeds total tokens";
    default:
      return assertNever(error.code, "unhandled context budget error");
  }
}

function destinationEligible(
  sensitivity: ArtifactSensitivity,
  destination: ContextBudgetDestination,
): boolean {
  switch (destination) {
    case "local":
      return sensitivity !== "restricted";
    case "model":
      return sensitivity === "public" || sensitivity === "user-content";
    case "support":
      return sensitivity === "public";
    default:
      return assertNever(destination, "unhandled context budget destination");
  }
}

function isLossyProjection(candidate: EvidenceCandidate): boolean {
  switch (candidate.fidelity) {
    case "exact-source":
    case "bounded-excerpt":
    case "deterministic-transform":
      return false;
    case "extractive-summary":
    case "lossy-synthesis":
      return true;
    default:
      return assertNever(candidate.fidelity, "unhandled evidence fidelity");
  }
}

function pressureForReason(reason: ContextBudgetOmissionReason): ContextPressureKind {
  switch (reason) {
    case "secret":
    case "destination-ineligible":
      return "sensitivity";
    case "item-limit":
    case "budget-exceeded":
      return "token";
    case "duplicate":
    case "deferred-retrievable":
    case "lossy-projection":
    case "source-class-limit":
      return "item";
    case "latency-limit":
      return "latency";
    default:
      return assertNever(reason, "unhandled context budget omission");
  }
}

function exceedsItemCap(charge: ResolvedCharge, profile: ContextBudgetProfile): boolean {
  return (
    charge.candidate.estimatedTokens > profile.maxItemTokens || charge.bytes > profile.maxItemBytes
  );
}

function fits(
  charge: ResolvedCharge,
  profile: ContextBudgetProfile,
  usedTokens: number,
  usedBytes: number,
  usedItems: number,
  usedLatency: number,
  usedByKind: Readonly<
    Partial<Record<EvidenceSourceKind, { tokens: number; bytes: number; items: number }>>
  >,
): ContextBudgetOmissionReason | null {
  const remainingTokens =
    profile.maxTotalTokens - profile.reservedOutputTokens - profile.reservedToolFramingTokens;
  if (usedItems + 1 > profile.maxItems) {
    return "budget-exceeded";
  }
  if (usedTokens + charge.candidate.estimatedTokens > remainingTokens) {
    return "budget-exceeded";
  }
  if (usedBytes + charge.bytes > profile.maxTotalBytes) {
    return "budget-exceeded";
  }
  if (usedLatency + charge.latencyMs > profile.maxLatencyMs) {
    return "latency-limit";
  }
  const classLimit = profile.sourceClass[charge.candidate.sourceKind];
  if (classLimit !== undefined) {
    const used = usedByKind[charge.candidate.sourceKind] ?? { tokens: 0, bytes: 0, items: 0 };
    if (classLimit.maxItems !== null && used.items + 1 > classLimit.maxItems) {
      return "source-class-limit";
    }
    if (
      classLimit.maxTokens !== null &&
      used.tokens + charge.candidate.estimatedTokens > classLimit.maxTokens
    ) {
      return "source-class-limit";
    }
    if (classLimit.maxBytes !== null && used.bytes + charge.bytes > classLimit.maxBytes) {
      return "source-class-limit";
    }
  }
  return null;
}

function addUsage(
  charge: ResolvedCharge,
  usedByKind: Partial<Record<EvidenceSourceKind, { tokens: number; bytes: number; items: number }>>,
): void {
  const current = usedByKind[charge.candidate.sourceKind] ?? { tokens: 0, bytes: 0, items: 0 };
  usedByKind[charge.candidate.sourceKind] = {
    tokens: current.tokens + charge.candidate.estimatedTokens,
    bytes: current.bytes + charge.bytes,
    items: current.items + 1,
  };
}

function demandExceeds(charges: readonly ResolvedCharge[], profile: ContextBudgetProfile): boolean {
  let tokens = 0;
  let bytes = 0;
  let latency = 0;
  for (const charge of charges) {
    tokens += charge.candidate.estimatedTokens;
    bytes += charge.bytes;
    latency += charge.latencyMs;
  }
  const remainingTokens =
    profile.maxTotalTokens - profile.reservedOutputTokens - profile.reservedToolFramingTokens;
  return (
    charges.length > profile.maxItems ||
    tokens > remainingTokens ||
    bytes > profile.maxTotalBytes ||
    latency > profile.maxLatencyMs
  );
}

function dropWhere(
  charges: readonly ResolvedCharge[],
  reason: ContextBudgetOmissionReason,
  shouldDrop: (charge: ResolvedCharge) => boolean,
): {
  readonly kept: readonly ResolvedCharge[];
  readonly omitted: readonly ContextBudgetOmission[];
} {
  const kept: ResolvedCharge[] = [];
  const omitted: ContextBudgetOmission[] = [];
  for (const charge of charges) {
    if (shouldDrop(charge) && !charge.required) {
      omitted.push({ id: charge.candidate.id, reason });
      continue;
    }
    kept.push(charge);
  }
  return { kept, omitted };
}

function applyPressure(
  charges: readonly ResolvedCharge[],
  profile: ContextBudgetProfile,
): {
  readonly kept: readonly ResolvedCharge[];
  readonly omitted: readonly ContextBudgetOmission[];
  readonly applied: readonly ContextPressureAction[];
} {
  const omitted: ContextBudgetOmission[] = [];
  const applied: ContextPressureAction[] = [];
  let working = charges;

  if (!demandExceeds(working, profile)) {
    return { kept: working, omitted, applied };
  }

  applied.push("remove-duplication");
  const seenOrigins = new Set<string>();
  const duplicates = dropWhere(working, "duplicate", (charge) => {
    if (seenOrigins.has(charge.candidate.origin)) {
      return true;
    }
    seenOrigins.add(charge.candidate.origin);
    return false;
  });
  working = duplicates.kept;
  omitted.push(...duplicates.omitted);
  if (!demandExceeds(working, profile)) {
    return { kept: working, omitted, applied };
  }

  applied.push("defer-retrievable");
  const deferred = dropWhere(
    working,
    "deferred-retrievable",
    (charge) => charge.candidate.expansion !== null,
  );
  working = deferred.kept;
  omitted.push(...deferred.omitted);
  if (!demandExceeds(working, profile)) {
    return { kept: working, omitted, applied };
  }

  applied.push("prefer-deterministic");
  const deterministic = dropWhere(working, "lossy-projection", (charge) =>
    isLossyProjection(charge.candidate),
  );
  working = deterministic.kept;
  omitted.push(...deterministic.omitted);
  return { kept: working, omitted, applied };
}

export function applyContextBudget(
  charges: readonly ContextBudgetCharge[],
  profileInput: ContextBudgetProfileInput = {},
): Result<ContextBudgetPlan, ContextBudgetError> {
  if (charges.length > HARD_CONTEXT_MAX_ITEMS) {
    return err(budgetError("oversized", "charges"));
  }
  const profile = parseContextBudgetProfile(profileInput);
  if (!profile.ok) {
    return profile;
  }

  const resolved: ResolvedCharge[] = [];
  const seenIds = new Set<EvidenceId>();
  for (const charge of charges) {
    if (seenIds.has(charge.candidate.id)) {
      return err(budgetError("malformed", "charges"));
    }
    seenIds.add(charge.candidate.id);
    const latency =
      charge.latencyMs === undefined ? parseDuration(0) : parseDuration(charge.latencyMs);
    if (!latency.ok) {
      return err(budgetError("malformed", "latencyMs"));
    }
    resolved.push({
      candidate: charge.candidate,
      latencyMs: latency.value,
      required: charge.required === true,
      bytes: charge.candidate.payload.byteLength,
    });
  }

  const remainingTokens =
    profile.value.maxTotalTokens -
    profile.value.reservedOutputTokens -
    profile.value.reservedToolFramingTokens;

  const gated: ResolvedCharge[] = [];
  const omitted: ContextBudgetOmission[] = [];
  for (const charge of resolved) {
    if (charge.candidate.sensitivity === "restricted") {
      omitted.push({ id: charge.candidate.id, reason: "secret" });
      continue;
    }
    if (!destinationEligible(charge.candidate.sensitivity, profile.value.destination)) {
      omitted.push({ id: charge.candidate.id, reason: "destination-ineligible" });
      continue;
    }
    if (exceedsItemCap(charge, profile.value)) {
      omitted.push({ id: charge.candidate.id, reason: "item-limit" });
      continue;
    }
    gated.push(charge);
  }

  const underPressure = demandExceeds(gated, profile.value);
  const working = underPressure
    ? applyPressure(gated, profile.value)
    : { kept: gated, omitted: [], applied: [] };
  omitted.push(...working.omitted);

  const included: EvidenceCandidate[] = [];
  let usedTokens = 0;
  let usedBytes = 0;
  let usedItems = 0;
  let usedLatency = 0;
  const usedByKind: Partial<
    Record<EvidenceSourceKind, { tokens: number; bytes: number; items: number }>
  > = {};
  for (const charge of working.kept) {
    const refusal = fits(
      charge,
      profile.value,
      usedTokens,
      usedBytes,
      usedItems,
      usedLatency,
      usedByKind,
    );
    if (refusal !== null) {
      omitted.push({ id: charge.candidate.id, reason: refusal });
      continue;
    }
    included.push(charge.candidate);
    usedTokens += charge.candidate.estimatedTokens;
    usedBytes += charge.bytes;
    usedItems += 1;
    usedLatency += charge.latencyMs;
    addUsage(charge, usedByKind);
  }

  const omittedIds = new Set(omitted.map((entry) => entry.id));
  const requiredMissed = resolved.some(
    (charge) => charge.required && omittedIds.has(charge.candidate.id),
  );
  const eligibleRequired = resolved.filter(
    (charge) =>
      charge.required &&
      charge.candidate.sensitivity !== "restricted" &&
      destinationEligible(charge.candidate.sensitivity, profile.value.destination),
  );
  const insufficient =
    requiredMissed || (eligibleRequired.length > 0 && included.length === 0)
      ? {
          kind: "insufficient-context" as const,
          recoveries: recoveriesFor(omitted),
        }
      : null;

  const pressure = uniquePressure(omitted, usedBytes, profile.value, remainingTokens, usedTokens);

  return ok({
    profile: profile.value,
    reservedOutputTokens: profile.value.reservedOutputTokens,
    reservedToolFramingTokens: profile.value.reservedToolFramingTokens,
    remainingTokens: remainingTokens - usedTokens,
    remainingBytes: profile.value.maxTotalBytes - usedBytes,
    remainingItems: profile.value.maxItems - usedItems,
    remainingLatencyMs: duration(profile.value.maxLatencyMs - usedLatency),
    included,
    omitted,
    pressure,
    appliedActions: working.applied,
    insufficient,
  });
}

function recoveriesFor(
  omitted: readonly ContextBudgetOmission[],
): readonly InsufficientContextRecovery[] {
  const recoveries = new Set<InsufficientContextRecovery>(["narrower-task"]);
  for (const entry of omitted) {
    switch (entry.reason) {
      case "deferred-retrievable":
        recoveries.add("artifact-expansion");
        recoveries.add("additional-retrieval");
        break;
      case "budget-exceeded":
      case "item-limit":
      case "source-class-limit":
      case "latency-limit":
        recoveries.add("different-model");
        break;
      case "duplicate":
      case "lossy-projection":
      case "secret":
      case "destination-ineligible":
        break;
      default:
        assertNever(entry.reason, "unhandled context budget omission");
    }
  }
  return INSUFFICIENT_CONTEXT_RECOVERIES.filter((recovery) => recoveries.has(recovery));
}

function uniquePressure(
  omitted: readonly ContextBudgetOmission[],
  usedBytes: number,
  profile: ContextBudgetProfile,
  remainingTokens: number,
  usedTokens: number,
): readonly ContextPressureKind[] {
  const kinds = new Set<ContextPressureKind>();
  for (const entry of omitted) {
    if (entry.reason === "item-limit") {
      kinds.add("token");
      kinds.add("byte");
      continue;
    }
    if (entry.reason === "budget-exceeded") {
      if (usedTokens >= remainingTokens) {
        kinds.add("token");
      }
      if (usedBytes >= profile.maxTotalBytes) {
        kinds.add("byte");
      }
      kinds.add("item");
      continue;
    }
    kinds.add(pressureForReason(entry.reason));
  }
  return CONTEXT_PRESSURE_KINDS.filter((kind) => kinds.has(kind));
}
