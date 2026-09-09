import {
  evaluateTrust,
  type TrustDecisionStore,
  type TrustObservation,
  type TrustProjection,
  trustDecisionKey,
} from "../../domain/security/ecosystem-trust.ts";

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
): CapabilityTrustPort {
  return {
    inspect(id) {
      const observation = observe(id);
      if (observation === null) return null;
      const decision = store.get(
        trustDecisionKey(observation.subject, observation.scope, observation.actor),
      );
      return decision.ok ? evaluateTrust(observation, decision.value) : null;
    },
  };
}
