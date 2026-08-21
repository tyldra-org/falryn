/**
 * Reachability garbage collection plan and outcome (#725).
 *
 * Computes what durable sessions and artifacts nothing retained still references,
 * previews candidates, and deletes only after an exact plan identity is
 * confirmed. Pinned, open, and export-seed sessions stay roots; artifact bytes
 * are rechecked before removal, the same mark-recheck-delete order the artifact
 * store sweep uses.
 */

import type { Brand } from "./identity.ts";
import type { MeasurementCompleteness } from "./local-data.ts";
import type { EffectCertainty } from "./outcome.ts";

/** A GC plan's identity, derived from its exact content. */
export type GcPlanId = Brand<string, "GcPlanId">;

export function isGcPlanId(value: unknown): value is GcPlanId {
  return typeof value === "string" && /^plan-gc-[0-9a-f]{8}-[0-9]+$/.test(value);
}

export const GC_CANDIDATE_KINDS = ["session", "artifact"] as const;
export type GcCandidateKind = (typeof GC_CANDIDATE_KINDS)[number];

export const GC_RETENTION_REASONS = [
  "reachable",
  "pinned",
  "open-session",
  "export-seed",
  "shared-digest",
  "referenced",
  "reserved-or-quarantined",
  "not-reached",
] as const;

export type GcRetentionReason = (typeof GC_RETENTION_REASONS)[number];

export type GcCandidate = {
  readonly kind: GcCandidateKind;
  readonly identity: string;
  readonly byteCount: number;
};

export type GcRetainedCount = {
  readonly reason: GcRetentionReason;
  readonly count: number;
};

export type GcOmission = {
  readonly kind: GcCandidateKind;
  readonly identity: string;
  readonly reason: GcRetentionReason;
};

export type GcPlan = {
  readonly planId: GcPlanId;
  readonly candidates: readonly GcCandidate[];
  readonly retained: readonly GcRetainedCount[];
  readonly omissions: readonly GcOmission[];
  readonly examinedSessions: number;
  readonly examinedArtifacts: number;
  readonly candidateSessions: number;
  readonly candidateArtifacts: number;
  readonly candidateBytes: number;
  readonly completeness: MeasurementCompleteness;
};

export type GcConfirmation = {
  readonly planId: GcPlanId;
};

export type GcRefusal =
  | {
      readonly code: "plan-mismatch";
      readonly expected: GcPlanId;
      readonly confirmed: GcPlanId;
    }
  | { readonly code: "cancelled" }
  | { readonly code: "live-store-open" };

export type GcOutcome = {
  readonly planId: GcPlanId;
  readonly deletedSessions: number;
  readonly deletedArtifacts: number;
  readonly deletedBytes: number;
  readonly retained: readonly GcRetainedCount[];
  readonly failed: number;
  readonly omissions: readonly GcOmission[];
  readonly completeness: MeasurementCompleteness;
  readonly effect: EffectCertainty;
};

export type ReachabilityGcError =
  | { readonly kind: "reachability-gc"; readonly code: "cancelled" }
  | { readonly kind: "reachability-gc"; readonly code: "storage"; readonly detail: string }
  | { readonly kind: "reachability-gc"; readonly code: "bound-exceeded"; readonly bound: string };
