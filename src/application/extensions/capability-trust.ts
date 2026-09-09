import {
  evaluateTrust,
  type TrustDecisionStore,
  type TrustObservation,
  type TrustProjection,
  trustDecisionKey,
} from "../../domain/security/ecosystem-trust.ts";
import {
  type PackageProvenanceStore,
  packageProvenanceKey,
  withPackageProvenance,
} from "../../domain/security/package-provenance.ts";
import type { FullUserGrantAdmissionPort } from "./full-user-grant.ts";

export interface CapabilityTrustPort {
  /** Read current facts at admission, not an old catalog label. Missing/unreadable facts deny. */
  inspect(capabilityId: string): TrustProjection | null;
}
export function requiresEcosystemTrust(source: string): boolean {
  return source === "plugin" || source === "mcp" || source === "marketplace";
}
export function createCapabilityTrust(
  store: TrustDecisionStore,
  observe: (capabilityId: string) => TrustObservation | null,
  provenance?: PackageProvenanceStore,
  grants?: FullUserGrantAdmissionPort,
): CapabilityTrustPort {
  return {
    inspect(id) {
      let observation = observe(id);
      if (observation === null) return null;
      if (provenance !== undefined) {
        const facts = provenance.get(packageProvenanceKey(observation));
        if (!facts.ok) return null;
        observation = withPackageProvenance(observation, facts.value);
      }
      const decision = store.get(
        trustDecisionKey(observation.subject, observation.scope, observation.actor),
      );
      if (!decision.ok) return null;
      const trust = evaluateTrust(observation, decision.value);
      const grant = grants?.inspect(id, trust);
      return grant === undefined || grant === null
        ? trust
        : { ...trust, eligible: trust.eligible && grant.eligible, executionGrant: grant };
    },
  };
}
