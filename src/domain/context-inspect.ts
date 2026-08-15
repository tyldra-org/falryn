/**
 * Context-engine scenario inspection for stale, conflict, scale, and
 * long-session pressure (#87).
 *
 * Classifies already-admitted #82 candidates. Same-origin items with
 * disagreeing exact-source or expansion digests are a digest mismatch.
 * Live versus stale on the same origin is a freshness mismatch. Reports
 * list branded ids and a reason only; they never merge payloads or rewrite
 * stale to live. This gate does not rank, budget, compose, or expand.
 */

import type { ContentDigest } from "./artifact.ts";
import {
  type EvidenceCandidate,
  type EvidenceFreshness,
  MAX_EVIDENCE_BATCH,
} from "./context-evidence.ts";
import type { EvidenceId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const DEFAULT_LONG_SESSION_CONVERSATION_ITEMS = 16;

export const CONTEXT_CONFLICT_REASONS = ["digest-mismatch", "freshness-mismatch"] as const;
export type ContextConflictReason = (typeof CONTEXT_CONFLICT_REASONS)[number];

export const CONTEXT_BATCH_STATUSES = ["ok", "at-limit"] as const;
export type ContextBatchStatus = (typeof CONTEXT_BATCH_STATUSES)[number];

export type ContextInspectErrorCode = "oversized";

export type ContextInspectError = {
  readonly kind: "context-inspect";
  readonly code: ContextInspectErrorCode;
  readonly field: string | null;
};

export type ContextConflict = {
  readonly ids: readonly EvidenceId[];
  readonly reason: ContextConflictReason;
};

export type ContextInspectReport = {
  readonly conflicts: readonly ContextConflict[];
  readonly staleIds: readonly EvidenceId[];
  readonly batch: ContextBatchStatus;
  readonly conversationCount: number;
  readonly longSession: boolean;
};

function inspectError(code: ContextInspectErrorCode, field: string | null): ContextInspectError {
  return { kind: "context-inspect", code, field };
}

export function describeContextInspectError(error: ContextInspectError): string {
  const field = error.field === null ? "inspection" : error.field;
  switch (error.code) {
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled context inspect error");
  }
}

function compareEvidenceIds(left: EvidenceId, right: EvidenceId): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sourceDigest(candidate: EvidenceCandidate): ContentDigest | null {
  if (candidate.exactSource !== null) {
    return candidate.exactSource.digest;
  }
  if (candidate.expansion !== null) {
    return candidate.expansion.digest;
  }
  return null;
}

function isNonStale(freshness: EvidenceFreshness): boolean {
  switch (freshness) {
    case "live":
    case "snapshot":
    case "indexed":
      return true;
    case "stale":
      return false;
    default:
      return assertNever(freshness, "unhandled evidence freshness");
  }
}

function conflictReason(group: readonly EvidenceCandidate[]): ContextConflictReason | null {
  if (group.length < 2) {
    return null;
  }
  const digests = new Set<string>();
  let hasStale = false;
  let hasNonStale = false;
  for (const candidate of group) {
    const digest = sourceDigest(candidate);
    if (digest !== null) {
      digests.add(digest);
    }
    if (candidate.freshness === "stale") {
      hasStale = true;
    } else if (isNonStale(candidate.freshness)) {
      hasNonStale = true;
    }
  }
  if (digests.size > 1) {
    return "digest-mismatch";
  }
  if (hasStale && hasNonStale) {
    return "freshness-mismatch";
  }
  return null;
}

export function inspectContextEvidence(
  candidates: readonly EvidenceCandidate[],
): Result<ContextInspectReport, ContextInspectError> {
  if (candidates.length > MAX_EVIDENCE_BATCH) {
    return err(inspectError("oversized", "batch"));
  }

  const groups = new Map<string, EvidenceCandidate[]>();
  const staleIds: EvidenceId[] = [];
  let conversationCount = 0;
  for (const candidate of candidates) {
    const existing = groups.get(candidate.origin);
    if (existing === undefined) {
      groups.set(candidate.origin, [candidate]);
    } else {
      existing.push(candidate);
    }
    if (candidate.freshness === "stale") {
      staleIds.push(candidate.id);
    }
    if (candidate.sourceKind === "conversation") {
      conversationCount += 1;
    }
  }
  staleIds.sort(compareEvidenceIds);

  const conflicts: ContextConflict[] = [];
  for (const group of groups.values()) {
    const reason = conflictReason(group);
    if (reason === null) {
      continue;
    }
    const ids = group.map((candidate) => candidate.id).sort(compareEvidenceIds);
    conflicts.push({ ids, reason });
  }
  conflicts.sort((left, right) => {
    const leftId = left.ids[0];
    const rightId = right.ids[0];
    if (leftId === undefined || rightId === undefined) {
      return 0;
    }
    return compareEvidenceIds(leftId, rightId);
  });

  return ok({
    conflicts,
    staleIds,
    batch: candidates.length === MAX_EVIDENCE_BATCH ? "at-limit" : "ok",
    conversationCount,
    longSession: conversationCount >= DEFAULT_LONG_SESSION_CONVERSATION_ITEMS,
  });
}
