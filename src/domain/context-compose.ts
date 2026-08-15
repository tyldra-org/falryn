/**
 * Context-engine pack composition with citations and uncertainty (#85).
 *
 * Ranks and budgets admitted #82 candidates, then emits a bounded pack.
 * The first included item is primary; later items are support. Support inline
 * text may be narrowed; primary and artifact payloads are not rewritten.
 * Narrowing never claims exact-source. `#65` retrieval packs remain a
 * separate input type. This gate does not execute expansion or cache.
 */

import {
  applyContextBudget,
  type ContextBudgetCharge,
  type ContextBudgetError,
  type ContextBudgetOmissionReason,
  type ContextBudgetPlan,
  type ContextBudgetProfileInput,
  type InsufficientContext,
} from "./context-budget.ts";
import {
  claimsExactSource,
  type EvidenceCandidate,
  type EvidenceExpansionHandle,
  type EvidenceFidelity,
  type EvidenceFreshness,
  type EvidenceSourceKind,
  type ExactSourceHandle,
  MAX_EVIDENCE_BATCH,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import {
  type ContextRankError,
  type ContextRankInput,
  type ContextRankOmissionReason,
  type ContextRankSignal,
  rankAndSelectContext,
} from "./context-rank.ts";
import type { EvidenceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_SUPPORT_EXCERPT_BYTES = 2 * 1_024;
export const HARD_SUPPORT_EXCERPT_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const CONTEXT_PACK_EXCERPT_BYTES_PER_TOKEN = 4;

export const CONTEXT_PACK_ROLES = ["primary", "support"] as const;
export type ContextPackRole = (typeof CONTEXT_PACK_ROLES)[number];

export const CONTEXT_PACK_OMISSION_STAGES = ["rank", "budget"] as const;
export type ContextPackOmissionStage = (typeof CONTEXT_PACK_OMISSION_STAGES)[number];

export const CONTEXT_PACK_UNCERTAINTIES = [
  "stale",
  "inferred",
  "untrusted",
  "extractive",
  "lossy",
  "narrowed",
  "insufficient",
] as const;
export type ContextPackUncertainty = (typeof CONTEXT_PACK_UNCERTAINTIES)[number];

export type ContextPackOmissionReason = ContextRankOmissionReason | ContextBudgetOmissionReason;

export type ContextComposeErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "reservation-exceeds-total";

export type ContextComposeError = {
  readonly kind: "context-compose";
  readonly code: ContextComposeErrorCode;
  readonly field: string | null;
};

export type ContextPackCitation = {
  readonly id: EvidenceId;
  readonly origin: string;
  readonly sourceKind: EvidenceSourceKind;
  readonly freshness: EvidenceFreshness;
  readonly fidelity: EvidenceFidelity;
  readonly exactSource: ExactSourceHandle | null;
  readonly expansion: EvidenceExpansionHandle | null;
};

export type ContextPackOmission = {
  readonly id: EvidenceId;
  readonly stage: ContextPackOmissionStage;
  readonly reason: ContextPackOmissionReason;
};

export type ComposedContextPackItem = {
  readonly candidate: EvidenceCandidate;
  readonly role: ContextPackRole;
  readonly citation: ContextPackCitation;
  readonly reasons: readonly ContextRankSignal[];
  readonly uncertainty: readonly ContextPackUncertainty[];
  readonly excerpt: string | null;
  readonly excerptBytes: number;
  readonly estimatedTokens: number;
  readonly fidelity: EvidenceFidelity;
  readonly narrowed: boolean;
  readonly claimsExact: boolean;
};

export type ComposedContextPack = {
  readonly items: readonly ComposedContextPackItem[];
  readonly omitted: readonly ContextPackOmission[];
  readonly uncertainty: readonly ContextPackUncertainty[];
  readonly insufficient: InsufficientContext | null;
  readonly truncated: boolean;
  readonly budget: ContextBudgetPlan;
};

export type ContextComposeInput = {
  readonly rank?: ContextRankInput;
  readonly budget?: ContextBudgetProfileInput;
  readonly requiredIds?: readonly string[];
  readonly latencyById?: Readonly<Record<string, number>>;
  readonly maxSupportExcerptBytes?: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function composeError(code: ContextComposeErrorCode, field: string | null): ContextComposeError {
  return { kind: "context-compose", code, field };
}

function fromRank(error: ContextRankError): ContextComposeError {
  return composeError(error.code, error.field);
}

function fromBudget(error: ContextBudgetError): ContextComposeError {
  return composeError(error.code, error.field);
}

export function describeContextComposeError(error: ContextComposeError): string {
  const field = error.field === null ? "pack" : error.field;
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
      return assertNever(error.code, "unhandled context compose error");
  }
}

function parseSupportExcerptBytes(value: number | undefined): Result<number, ContextComposeError> {
  if (value === undefined) {
    return ok(DEFAULT_SUPPORT_EXCERPT_BYTES);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    return err(composeError("malformed", "maxSupportExcerptBytes"));
  }
  if (value > HARD_SUPPORT_EXCERPT_BYTES) {
    return err(composeError("oversized", "maxSupportExcerptBytes"));
  }
  return ok(value);
}

function parseRequiredIds(
  values: readonly string[] | undefined,
): Result<ReadonlySet<string>, ContextComposeError> {
  if (values === undefined) {
    return ok(new Set());
  }
  if (values.length > MAX_EVIDENCE_BATCH) {
    return err(composeError("oversized", "requiredIds"));
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      return err(composeError("malformed", "requiredIds"));
    }
    ids.add(value);
  }
  return ok(ids);
}

function parseLatencyById(
  values: Readonly<Record<string, number>> | undefined,
): Result<ReadonlyMap<string, number>, ContextComposeError> {
  if (values === undefined) {
    return ok(new Map());
  }
  const keys = Object.keys(values);
  if (keys.length > MAX_EVIDENCE_BATCH) {
    return err(composeError("oversized", "latencyById"));
  }
  const latencies = new Map<string, number>();
  for (const key of keys) {
    if (key.length === 0) {
      return err(composeError("malformed", "latencyById"));
    }
    const latency = values[key];
    if (typeof latency !== "number" || !Number.isSafeInteger(latency) || latency < 0) {
      return err(composeError("malformed", "latencyMs"));
    }
    latencies.set(key, latency);
  }
  return ok(latencies);
}

function utf8LeadLength(lead: number): number {
  if ((lead & 0b1000_0000) === 0) {
    return 1;
  }
  if ((lead & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((lead & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((lead & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0) {
    const previous = bytes[end - 1];
    if (previous === undefined || (previous & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    end -= 1;
  }
  const lead = end > 0 ? bytes[end - 1] : undefined;
  if (lead !== undefined && end - 1 + utf8LeadLength(lead) > maxBytes) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

function tokensForBytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / CONTEXT_PACK_EXCERPT_BYTES_PER_TOKEN));
}

function itemUncertainty(
  candidate: EvidenceCandidate,
  narrowed: boolean,
): readonly ContextPackUncertainty[] {
  const flags: ContextPackUncertainty[] = [];
  if (candidate.freshness === "stale") {
    flags.push("stale");
  }
  if (candidate.trust === "inferred") {
    flags.push("inferred");
  }
  if (candidate.trust === "untrusted") {
    flags.push("untrusted");
  }
  switch (candidate.fidelity) {
    case "extractive-summary":
      flags.push("extractive");
      break;
    case "lossy-synthesis":
      flags.push("lossy");
      break;
    case "exact-source":
    case "bounded-excerpt":
    case "deterministic-transform":
      break;
    default:
      return assertNever(candidate.fidelity, "unhandled evidence fidelity");
  }
  if (narrowed) {
    flags.push("narrowed");
  }
  return flags;
}

function packUncertainty(
  items: readonly ComposedContextPackItem[],
  insufficient: InsufficientContext | null,
): readonly ContextPackUncertainty[] {
  const present = new Set<ContextPackUncertainty>();
  for (const item of items) {
    for (const flag of item.uncertainty) {
      present.add(flag);
    }
  }
  const ordered: ContextPackUncertainty[] = [];
  for (const kind of CONTEXT_PACK_UNCERTAINTIES) {
    switch (kind) {
      case "insufficient":
        if (insufficient !== null) {
          ordered.push(kind);
        }
        break;
      case "stale":
      case "inferred":
      case "untrusted":
      case "extractive":
      case "lossy":
      case "narrowed":
        if (present.has(kind)) {
          ordered.push(kind);
        }
        break;
      default:
        return assertNever(kind, "unhandled pack uncertainty");
    }
  }
  return ordered;
}

function citationFor(candidate: EvidenceCandidate): ContextPackCitation {
  return {
    id: candidate.id,
    origin: candidate.origin,
    sourceKind: candidate.sourceKind,
    freshness: candidate.freshness,
    fidelity: candidate.fidelity,
    exactSource: candidate.exactSource,
    expansion: candidate.expansion,
  };
}

function projectItem(
  candidate: EvidenceCandidate,
  role: ContextPackRole,
  reasons: readonly ContextRankSignal[],
  maxSupportExcerptBytes: number,
): ComposedContextPackItem {
  if (candidate.payload.kind === "artifact" || role === "primary") {
    return {
      candidate,
      role,
      citation: citationFor(candidate),
      reasons,
      uncertainty: itemUncertainty(candidate, false),
      excerpt: candidate.payload.kind === "inline" ? candidate.payload.text : null,
      excerptBytes: candidate.payload.byteLength,
      estimatedTokens: candidate.estimatedTokens,
      fidelity: candidate.fidelity,
      narrowed: false,
      claimsExact: claimsExactSource(candidate),
    };
  }

  const original = candidate.payload.text;
  const excerpt = truncateUtf8(original, maxSupportExcerptBytes);
  const narrowed = excerpt !== original;
  const excerptBytes = encoder.encode(excerpt).byteLength;
  return {
    candidate,
    role,
    citation: citationFor(candidate),
    reasons,
    uncertainty: itemUncertainty(candidate, narrowed),
    excerpt,
    excerptBytes,
    estimatedTokens: narrowed
      ? Math.min(candidate.estimatedTokens, tokensForBytes(excerptBytes))
      : candidate.estimatedTokens,
    fidelity: narrowed ? "bounded-excerpt" : candidate.fidelity,
    narrowed,
    claimsExact: !narrowed && claimsExactSource(candidate),
  };
}

export function composeContextPack(
  candidates: readonly EvidenceCandidate[],
  input: ContextComposeInput = {},
): Result<ComposedContextPack, ContextComposeError> {
  const maxSupportExcerptBytes = parseSupportExcerptBytes(input.maxSupportExcerptBytes);
  if (!maxSupportExcerptBytes.ok) {
    return maxSupportExcerptBytes;
  }
  const requiredIds = parseRequiredIds(input.requiredIds);
  if (!requiredIds.ok) {
    return requiredIds;
  }
  const latencyById = parseLatencyById(input.latencyById);
  if (!latencyById.ok) {
    return latencyById;
  }

  const ranked = rankAndSelectContext(candidates, input.rank ?? {});
  if (!ranked.ok) {
    return err(fromRank(ranked.error));
  }

  const reasonsById = new Map<EvidenceId, readonly ContextRankSignal[]>();
  const charges: ContextBudgetCharge[] = [];
  for (const item of ranked.value.selected) {
    reasonsById.set(item.candidate.id, item.reasons);
    const latencyMs = latencyById.value.get(item.candidate.id);
    charges.push(
      latencyMs === undefined
        ? {
            candidate: item.candidate,
            required: requiredIds.value.has(item.candidate.id),
          }
        : {
            candidate: item.candidate,
            latencyMs,
            required: requiredIds.value.has(item.candidate.id),
          },
    );
  }

  const budget = applyContextBudget(charges, input.budget ?? {});
  if (!budget.ok) {
    return err(fromBudget(budget.error));
  }

  const items: ComposedContextPackItem[] = [];
  for (const [index, candidate] of budget.value.included.entries()) {
    const role: ContextPackRole = index === 0 ? "primary" : "support";
    items.push(
      projectItem(
        candidate,
        role,
        reasonsById.get(candidate.id) ?? [],
        maxSupportExcerptBytes.value,
      ),
    );
  }

  const omitted: ContextPackOmission[] = [
    ...ranked.value.omitted.map((entry) => ({
      id: entry.id,
      stage: "rank" as const,
      reason: entry.reason,
    })),
    ...budget.value.omitted.map((entry) => ({
      id: entry.id,
      stage: "budget" as const,
      reason: entry.reason,
    })),
  ];

  return ok({
    items,
    omitted,
    uncertainty: packUncertainty(items, budget.value.insufficient),
    insufficient: budget.value.insufficient,
    truncated: items.some((item) => item.narrowed),
    budget: budget.value,
  });
}
