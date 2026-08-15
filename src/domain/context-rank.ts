/**
 * Context-engine ranking and selection across tools, index, memory, and
 * conversation (#84).
 *
 * Scores admitted #82 candidates, then returns a stable ordered selection.
 * Query matching uses origin only. It does not apply #83 budgets, compose
 * packs, search payloads, or rewrite excerpts. Explanations never echo origin
 * or payload text.
 */

import type { ArtifactSensitivity } from "./artifact.ts";
import { CONTEXT_BUDGET_DESTINATIONS, type ContextBudgetDestination } from "./context-budget.ts";
import {
  type EvidenceCandidate,
  type EvidenceFidelity,
  type EvidenceFreshness,
  type EvidenceSourceKind,
  type EvidenceTrust,
  MAX_EVIDENCE_BATCH,
} from "./context-evidence.ts";
import type { EvidenceId, WorkspaceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_CONTEXT_MAX_PER_ORIGIN = 2;
export const DEFAULT_CONTEXT_MAX_SELECTED = 32;
export const HARD_CONTEXT_MAX_PER_ORIGIN = MAX_EVIDENCE_BATCH;
export const HARD_CONTEXT_MAX_SELECTED = MAX_EVIDENCE_BATCH;
export const MAX_CONTEXT_RANK_QUERY_LENGTH = 256;
export const MAX_CONTEXT_RANK_EXPLANATION = 8;

export const CONTEXT_RANK_SIGNALS = [
  "instruction-priority",
  "query-relevance",
  "freshness",
  "trust",
  "fidelity",
  "pinned",
  "recent-use",
  "workspace",
  "relationship",
  "destination",
  "cost",
] as const;
export type ContextRankSignal = (typeof CONTEXT_RANK_SIGNALS)[number];

export const CONTEXT_RANK_OMISSION_REASONS = [
  "diversity",
  "rank-limit",
  "below-threshold",
] as const;
export type ContextRankOmissionReason = (typeof CONTEXT_RANK_OMISSION_REASONS)[number];

export type ContextRankErrorCode = "malformed" | "unsupported" | "oversized";

export type ContextRankError = {
  readonly kind: "context-rank";
  readonly code: ContextRankErrorCode;
  readonly field: string | null;
};

export type ContextRankOmission = {
  readonly id: EvidenceId;
  readonly reason: ContextRankOmissionReason;
};

export type ContextRankedItem = {
  readonly candidate: EvidenceCandidate;
  readonly score: number;
  readonly reasons: readonly ContextRankSignal[];
};

export type ContextRankPlan = {
  readonly selected: readonly ContextRankedItem[];
  readonly omitted: readonly ContextRankOmission[];
};

export type ContextRankInput = {
  readonly query?: string;
  readonly pinnedIds?: readonly string[];
  readonly recentlyAcceptedIds?: readonly string[];
  readonly expectedWorkspaceId?: WorkspaceId;
  readonly destination?: string;
  readonly maxPerOrigin?: number;
  readonly maxSelected?: number;
  readonly minScore?: number;
};

function rankError(code: ContextRankErrorCode, field: string | null): ContextRankError {
  return { kind: "context-rank", code, field };
}

export function describeContextRankError(error: ContextRankError): string {
  const field = error.field === null ? "ranking" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled context rank error");
  }
}

function sourceKindPriority(kind: EvidenceSourceKind): number {
  switch (kind) {
    case "instruction":
      return 12;
    case "plan":
      return 11;
    case "conversation":
      return 10;
    case "diagnostic":
      return 9;
    case "symbol":
      return 8;
    case "file":
      return 7;
    case "search":
      return 6;
    case "tool":
      return 5;
    case "memory":
      return 4;
    case "artifact":
      return 3;
    case "attachment":
      return 2;
    case "process":
      return 1;
    default:
      return assertNever(kind, "unhandled evidence source kind");
  }
}

function freshnessScore(freshness: EvidenceFreshness): number {
  switch (freshness) {
    case "live":
      return 4;
    case "snapshot":
      return 3;
    case "indexed":
      return 2;
    case "stale":
      return 0;
    default:
      return assertNever(freshness, "unhandled evidence freshness");
  }
}

function trustScore(trust: EvidenceTrust): number {
  switch (trust) {
    case "user-confirmed":
      return 4;
    case "adapter-declared":
      return 3;
    case "inferred":
      return 1;
    case "untrusted":
      return 0;
    default:
      return assertNever(trust, "unhandled evidence trust");
  }
}

function fidelityScore(fidelity: EvidenceFidelity): number {
  switch (fidelity) {
    case "exact-source":
      return 4;
    case "bounded-excerpt":
      return 3;
    case "deterministic-transform":
      return 2;
    case "extractive-summary":
      return 1;
    case "lossy-synthesis":
      return 0;
    default:
      return assertNever(fidelity, "unhandled evidence fidelity");
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

function parseBound(
  value: number | undefined,
  field: string,
  fallback: number,
  hardMax: number,
): Result<number, ContextRankError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    return err(rankError("malformed", field));
  }
  if (value > hardMax) {
    return err(rankError("oversized", field));
  }
  return ok(value);
}

function parseQuery(query: string | undefined): Result<string | null, ContextRankError> {
  if (query === undefined) {
    return ok(null);
  }
  if (query.includes("\0")) {
    return err(rankError("malformed", "query"));
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return ok(null);
  }
  if (trimmed.length > MAX_CONTEXT_RANK_QUERY_LENGTH) {
    return err(rankError("oversized", "query"));
  }
  return ok(trimmed);
}

function parseDestination(
  destination: string | undefined,
): Result<ContextBudgetDestination | null, ContextRankError> {
  if (destination === undefined) {
    return ok(null);
  }
  if (!(CONTEXT_BUDGET_DESTINATIONS as readonly string[]).includes(destination)) {
    return err(rankError("unsupported", "destination"));
  }
  return ok(destination as ContextBudgetDestination);
}

function parseIdSet(
  values: readonly string[] | undefined,
  field: string,
): Result<ReadonlySet<EvidenceId>, ContextRankError> {
  if (values === undefined) {
    return ok(new Set());
  }
  if (values.length > MAX_EVIDENCE_BATCH) {
    return err(rankError("oversized", field));
  }
  const ids = new Set<EvidenceId>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      return err(rankError("malformed", field));
    }
    ids.add(value as EvidenceId);
  }
  return ok(ids);
}

function queryMatch(origin: string, query: string): number {
  const originFolded = origin.toLowerCase();
  const queryFolded = query.toLowerCase();
  if (originFolded === queryFolded) {
    return 1200;
  }
  if (originFolded.includes(queryFolded)) {
    return 800;
  }
  return 0;
}

function costPenalty(candidate: EvidenceCandidate): number {
  const retrieval = Math.min(candidate.retrievalCost, 200);
  const tokens = Math.min(Math.floor(candidate.estimatedTokens / 32), 200);
  return retrieval + tokens;
}

type Scored = {
  readonly candidate: EvidenceCandidate;
  readonly score: number;
  readonly reasons: readonly ContextRankSignal[];
};

function scoreCandidate(
  candidate: EvidenceCandidate,
  query: string | null,
  pinned: ReadonlySet<EvidenceId>,
  recent: ReadonlySet<EvidenceId>,
  expectedWorkspaceId: WorkspaceId | undefined,
  destination: ContextBudgetDestination | null,
): Scored {
  const reasons: ContextRankSignal[] = [];
  let score = sourceKindPriority(candidate.sourceKind) * 1000;
  if (candidate.sourceKind === "instruction") {
    reasons.push("instruction-priority");
  }

  if (query !== null) {
    const match = queryMatch(candidate.origin, query);
    score += match;
    if (match > 0) {
      reasons.push("query-relevance");
    }
  }

  const freshness = freshnessScore(candidate.freshness);
  score += freshness * 250;
  if (freshness > 0) {
    reasons.push("freshness");
  }

  const trust = trustScore(candidate.trust);
  score += trust * 250;
  if (trust > 0) {
    reasons.push("trust");
  }

  const fidelity = fidelityScore(candidate.fidelity);
  score += fidelity * 200;
  if (fidelity > 0) {
    reasons.push("fidelity");
  }

  if (pinned.has(candidate.id)) {
    score += 10_000;
    reasons.push("pinned");
  }
  if (recent.has(candidate.id)) {
    score += 500;
    reasons.push("recent-use");
  }
  if (expectedWorkspaceId !== undefined && candidate.workspaceId === expectedWorkspaceId) {
    score += 400;
    reasons.push("workspace");
  }
  if (candidate.relationships.some((id) => pinned.has(id))) {
    score += 300;
    reasons.push("relationship");
  }
  if (destination !== null && destinationEligible(candidate.sensitivity, destination)) {
    score += 150;
    reasons.push("destination");
  }

  const penalty = costPenalty(candidate);
  score -= penalty;
  if (penalty > 0) {
    reasons.push("cost");
  }

  return {
    candidate,
    score,
    reasons: CONTEXT_RANK_SIGNALS.filter((signal) => reasons.includes(signal)).slice(
      0,
      MAX_CONTEXT_RANK_EXPLANATION,
    ),
  };
}

function compareScored(left: Scored, right: Scored): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const byKind =
    sourceKindPriority(right.candidate.sourceKind) - sourceKindPriority(left.candidate.sourceKind);
  if (byKind !== 0) {
    return byKind;
  }
  if (left.candidate.origin < right.candidate.origin) {
    return -1;
  }
  if (left.candidate.origin > right.candidate.origin) {
    return 1;
  }
  if (left.candidate.id < right.candidate.id) {
    return -1;
  }
  if (left.candidate.id > right.candidate.id) {
    return 1;
  }
  return 0;
}

export function rankAndSelectContext(
  candidates: readonly EvidenceCandidate[],
  input: ContextRankInput = {},
): Result<ContextRankPlan, ContextRankError> {
  if (candidates.length > MAX_EVIDENCE_BATCH) {
    return err(rankError("oversized", "candidates"));
  }
  const query = parseQuery(input.query);
  if (!query.ok) {
    return query;
  }
  const destination = parseDestination(input.destination);
  if (!destination.ok) {
    return destination;
  }
  const maxPerOrigin = parseBound(
    input.maxPerOrigin,
    "maxPerOrigin",
    DEFAULT_CONTEXT_MAX_PER_ORIGIN,
    HARD_CONTEXT_MAX_PER_ORIGIN,
  );
  if (!maxPerOrigin.ok) {
    return maxPerOrigin;
  }
  const maxSelected = parseBound(
    input.maxSelected,
    "maxSelected",
    DEFAULT_CONTEXT_MAX_SELECTED,
    HARD_CONTEXT_MAX_SELECTED,
  );
  if (!maxSelected.ok) {
    return maxSelected;
  }
  if (input.minScore !== undefined && !Number.isSafeInteger(input.minScore)) {
    return err(rankError("malformed", "minScore"));
  }
  const pinned = parseIdSet(input.pinnedIds, "pinnedIds");
  if (!pinned.ok) {
    return pinned;
  }
  const recent = parseIdSet(input.recentlyAcceptedIds, "recentlyAcceptedIds");
  if (!recent.ok) {
    return recent;
  }

  const seen = new Set<EvidenceId>();
  const scored: Scored[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      return err(rankError("malformed", "candidates"));
    }
    seen.add(candidate.id);
    scored.push(
      scoreCandidate(
        candidate,
        query.value,
        pinned.value,
        recent.value,
        input.expectedWorkspaceId,
        destination.value,
      ),
    );
  }
  scored.sort(compareScored);

  const selected: ContextRankedItem[] = [];
  const omitted: ContextRankOmission[] = [];
  const perOrigin = new Map<string, number>();
  for (const item of scored) {
    if (input.minScore !== undefined && item.score < input.minScore) {
      omitted.push({ id: item.candidate.id, reason: "below-threshold" });
      continue;
    }
    const originCount = perOrigin.get(item.candidate.origin) ?? 0;
    if (originCount >= maxPerOrigin.value) {
      omitted.push({ id: item.candidate.id, reason: "diversity" });
      continue;
    }
    if (selected.length >= maxSelected.value) {
      omitted.push({ id: item.candidate.id, reason: "rank-limit" });
      continue;
    }
    perOrigin.set(item.candidate.origin, originCount + 1);
    selected.push({
      candidate: item.candidate,
      score: item.score,
      reasons: item.reasons,
    });
  }

  return ok({ selected, omitted });
}
