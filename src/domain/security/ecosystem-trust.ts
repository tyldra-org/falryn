/** Evidence describes provenance. A user decision never manufactures verification or effects authority. */
import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import { digestSchema, generationSchema, packageIdentityV1Schema } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";

export const TRUST_STATES = [
  "unknown",
  "unverified",
  "user-approved",
  "verified",
  "curated",
  "degraded",
  "quarantined",
  "revoked",
  "incompatible",
] as const;
const timestamp = z.int().nonnegative();
export const trustScopeSchema = z.strictObject({
  kind: z.enum(["user", "workspace", "session"]),
  authority: digestSchema,
});
export const trustSubjectSchema = z.strictObject({
  identity: packageIdentityV1Schema,
  ownership: z.strictObject({
    sourceOwner: digestSchema.nullable(),
    publisher: digestSchema.nullable(),
  }),
});
export const trustEvidenceSchema = z.strictObject({
  integrity: z.enum(["unknown", "computed", "verified", "mismatch"]),
  signature: z.enum(["unavailable", "unsigned", "verified", "invalid", "conflicting"]),
  curation: z.enum(["unavailable", "verified"]),
  advisory: z.enum(["unavailable", "clear", "quarantined", "revoked"]),
  observedAt: timestamp,
  expiresAt: timestamp.nullable(),
  reference: digestSchema,
});
export const trustDecisionSchema = z
  .strictObject({
    version: z.literal(1),
    subject: trustSubjectSchema,
    evidence: trustEvidenceSchema,
    policyGeneration: generationSchema,
    actor: digestSchema,
    scope: trustScopeSchema,
    contributions: z.array(digestSchema).max(1_024),
    revision: z.int().positive(),
    action: z.enum(["approve", "revoke"]),
    decidedAt: timestamp,
    expiresAt: timestamp.nullable(),
  })
  .refine((value) =>
    value.action === "revoke"
      ? value.expiresAt === null
      : value.expiresAt !== null && value.expiresAt > value.decidedAt,
  );
export type TrustSubject = z.infer<typeof trustSubjectSchema>;
export type TrustEvidence = z.infer<typeof trustEvidenceSchema>;
export type TrustDecision = z.infer<typeof trustDecisionSchema>;
export type TrustScope = z.infer<typeof trustScopeSchema>;
export type TrustObservation = {
  readonly subject: TrustSubject;
  readonly evidence: TrustEvidence;
  readonly policyGeneration: number;
  readonly scope: TrustScope;
  readonly actor: string;
  readonly now: number;
  readonly compatibility: "compatible" | "incompatible";
  readonly health: "healthy" | "degraded" | "unknown";
  readonly availability: "available" | "unavailable" | "unknown";
  readonly online: boolean;
};
export type TrustProjection = {
  readonly decisionKey: string;
  readonly version: 1;
  readonly subject: TrustSubject;
  readonly state: (typeof TRUST_STATES)[number];
  readonly evidence: TrustEvidence;
  readonly freshness: "current" | "stale" | "unavailable";
  readonly online: boolean;
  readonly decision: TrustDecision | null;
  readonly decisionStatus: "absent" | "matching" | "expired" | "stale" | "revoked";
  readonly scope: TrustScope;
  readonly policyGeneration: number;
  readonly compatibility: TrustObservation["compatibility"];
  readonly health: TrustObservation["health"];
  readonly availability: TrustObservation["availability"];
  /** Eligibility is an additional check, never a full-user grant or tool permission. */
  readonly eligible: boolean;
  readonly executionGrant?: {
    readonly eligible: boolean;
    readonly reason: string;
    readonly id: string;
    readonly revision: number;
  };
};
export function trustDecisionKey(subject: TrustSubject, scope: TrustScope, actor: string): string {
  return canonicalDigest({ subject, scope, actor });
}
/** Acquisition timestamps do not invalidate approval when the actual evidence is unchanged. */
export function trustEvidenceBinding(evidence: TrustEvidence): string {
  const { observedAt: _observedAt, expiresAt: _expiresAt, ...facts } = evidence;
  return canonicalDigest(facts);
}
export function evaluateTrust(
  observation: TrustObservation,
  decision: TrustDecision | null,
): TrustProjection {
  const { evidence, now } = observation;
  const freshness =
    evidence.observedAt > now || (evidence.expiresAt !== null && evidence.expiresAt <= now)
      ? "stale"
      : evidence.advisory === "unavailable"
        ? "unavailable"
        : "current";
  const sameSubject =
    decision !== null &&
    trustDecisionKey(decision.subject, decision.scope, decision.actor) ===
      trustDecisionKey(observation.subject, observation.scope, observation.actor);
  const revoked = sameSubject && decision.action === "revoke";
  const bindingMatches =
    sameSubject &&
    decision.policyGeneration === observation.policyGeneration &&
    decision.decidedAt <= now &&
    trustEvidenceBinding(decision.evidence) === trustEvidenceBinding(evidence);
  const expired = bindingMatches && decision.expiresAt !== null && decision.expiresAt <= now;
  const matching = bindingMatches && !expired && !revoked;
  const decisionStatus =
    decision === null
      ? "absent"
      : revoked
        ? "revoked"
        : expired
          ? "expired"
          : matching
            ? "matching"
            : "stale";
  let state: TrustProjection["state"];
  if (revoked || evidence.advisory === "revoked") state = "revoked";
  else if (
    evidence.integrity === "mismatch" ||
    evidence.signature === "invalid" ||
    evidence.signature === "conflicting" ||
    evidence.advisory === "quarantined"
  )
    state = "quarantined";
  else if (observation.compatibility === "incompatible") state = "incompatible";
  else if (freshness === "stale" || expired || (decision !== null && !matching)) state = "degraded";
  else if (matching) state = "user-approved";
  else if (evidence.integrity === "verified" && evidence.signature === "verified")
    state = evidence.curation === "verified" ? "curated" : "verified";
  else state = evidence.integrity === "unknown" ? "unknown" : "unverified";
  return {
    decisionKey: trustDecisionKey(observation.subject, observation.scope, observation.actor),
    version: 1,
    subject: observation.subject,
    state,
    evidence,
    freshness,
    online: observation.online,
    decision,
    decisionStatus,
    scope: observation.scope,
    policyGeneration: observation.policyGeneration,
    compatibility: observation.compatibility,
    health: observation.health,
    availability: observation.availability,
    eligible: matching && state === "user-approved",
  };
}
export type TrustStoreError = {
  readonly code: "malformed" | "unavailable" | "conflict" | "cancelled" | "uncertain";
};
export interface TrustDecisionStore {
  get(key: string): Result<TrustDecision | null, TrustStoreError>;
  /** Compare and replace under one durable transaction; no lost revocation on concurrent approval. */
  replace(
    key: string,
    expectedRevision: number,
    decision: TrustDecision,
    signal?: AbortSignal,
  ): Result<null, TrustStoreError>;
}
