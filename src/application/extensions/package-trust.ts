import { z } from "zod";
import { canonicalDigest, freezeMetadata } from "../../domain/extensions/canonical.ts";
import { digestSchema } from "../../domain/extensions/identity.ts";
import {
  evaluateTrust,
  type TrustDecisionStore,
  type TrustObservation,
  type TrustProjection,
  trustDecisionKey,
  trustDecisionSchema,
} from "../../domain/security/ecosystem-trust.ts";
import type { PreparedPackage } from "./prepare-package.ts";

export const TRUST_POLICY_GENERATION = 1;
export const MAX_TRUST_APPROVAL_MS = 30 * 24 * 60 * 60 * 1_000;
export const trustRequestSchema = z.strictObject({
  action: z.enum(["approve", "revoke"]),
  expiresAt: z.int().nonnegative().nullable(),
  confirmation: digestSchema.optional(),
  decisionKey: digestSchema.optional(),
});
export type TrustRequest = z.infer<typeof trustRequestSchema>;
export type PackageTrustResult =
  | { readonly status: "failed"; readonly code: string }
  | {
      readonly status: "inspected" | "preview" | "applied";
      readonly trust: TrustProjection;
      readonly confirmation: string | null;
      readonly affectedContributions: readonly string[];
    };

export function packageTrustObservation(
  prepared: PreparedPackage,
  actor: string,
  now: number,
): TrustObservation {
  return {
    subject: { identity: prepared.identity, ownership: prepared.ownership },
    evidence: {
      integrity: "computed",
      signature: "unavailable",
      curation: "unavailable",
      advisory: "unavailable",
      observedAt: now,
      expiresAt: null,
      reference: prepared.identity.packageDigest,
    },
    policyGeneration: TRUST_POLICY_GENERATION,
    actor,
    scope: { kind: "user", authority: actor },
    now,
    compatibility: prepared.compatibility,
    health: prepared.diagnostics.length > 0 || !prepared.dependencies.ok ? "degraded" : "unknown",
    availability: "unavailable",
    online: false,
  };
}

/** One owner for inspection and reversible user decisions. No activation/effect port is accepted. */
export function inspectPackageTrust(
  store: TrustDecisionStore,
  observation: TrustObservation,
  affectedContributions: readonly string[],
  request?: TrustRequest,
  signal?: AbortSignal,
): PackageTrustResult {
  if (signal?.aborted) return { status: "failed", code: "cancelled" };
  if (request !== undefined && !trustRequestSchema.safeParse(request).success)
    return { status: "failed", code: "malformed" };
  if (request?.decisionKey !== undefined && request.action !== "revoke")
    return { status: "failed", code: "invalid-decision-target" };
  const key =
    request?.decisionKey ??
    trustDecisionKey(observation.subject, observation.scope, observation.actor);
  const stored = store.get(key);
  if (!stored.ok) return { status: "failed", code: stored.error.code };
  if (request?.decisionKey !== undefined) {
    if (stored.value === null) return { status: "failed", code: "decision-not-found" };
    if (
      stored.value.actor !== observation.actor ||
      canonicalDigest(stored.value.scope) !== canonicalDigest(observation.scope)
    )
      return { status: "failed", code: "decision-not-owned" };
    observation = {
      ...observation,
      subject: stored.value.subject,
      evidence: stored.value.evidence,
      health: "unknown",
      availability: "unavailable",
    };
    affectedContributions = stored.value.contributions;
  }
  const trust = evaluateTrust(observation, stored.value);
  const result = { trust, affectedContributions: [...affectedContributions] };
  if (request === undefined)
    return freezeMetadata({ status: "inspected", ...result, confirmation: null });
  if (affectedContributions.length > 1_024) return { status: "failed", code: "malformed" };
  if (
    request.action === "approve" &&
    (request.expiresAt === null ||
      request.expiresAt <= observation.now ||
      request.expiresAt - observation.now > MAX_TRUST_APPROVAL_MS)
  )
    return { status: "failed", code: "invalid-approval-expiry" };
  if (request.action === "revoke" && request.expiresAt !== null)
    return { status: "failed", code: "invalid-revocation-expiry" };
  if (request.action === "approve" && ["quarantined", "incompatible"].includes(trust.state))
    return { status: "failed", code: "trust-evidence-denied" };
  if (request.action === "approve" && observation.evidence.advisory === "revoked")
    return { status: "failed", code: "trust-evidence-denied" };
  if (request.action === "approve" && trust.freshness === "stale")
    return { status: "failed", code: "stale-trust-evidence" };
  if (request.action === "revoke" && stored.value === null)
    return { status: "failed", code: "decision-not-found" };
  const revision = stored.value?.revision ?? 0;
  const confirmation = canonicalDigest({
    version: 1,
    key,
    revision,
    evidence: { ...observation.evidence, observedAt: 0 },
    policyGeneration: observation.policyGeneration,
    action: request.action,
    expiresAt: request.expiresAt,
    affectedContributions,
  });
  if (request.confirmation === undefined)
    return freezeMetadata({ status: "preview", ...result, confirmation });
  if (request.confirmation !== confirmation)
    return { status: "failed", code: "stale-trust-confirmation" };
  const decision = trustDecisionSchema.safeParse({
    version: 1,
    subject: observation.subject,
    evidence: observation.evidence,
    policyGeneration: observation.policyGeneration,
    actor: observation.actor,
    scope: observation.scope,
    contributions: [...affectedContributions],
    action: request.action,
    decidedAt: observation.now,
    expiresAt: request.expiresAt,
    revision: revision + 1,
  });
  if (!decision.success) return { status: "failed", code: "malformed" };
  const written = store.replace(key, revision, decision.data, signal);
  if (!written.ok) return { status: "failed", code: written.error.code };
  return freezeMetadata({
    status: "applied",
    trust: evaluateTrust(observation, decision.data),
    affectedContributions: [...affectedContributions],
    confirmation: null,
  });
}
