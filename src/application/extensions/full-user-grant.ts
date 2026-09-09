import type { TrustProjection } from "../../domain/security/ecosystem-trust.ts";
import {
  type FullUserGrantIdentityV1,
  type FullUserGrantStore,
  inspectFullUserGrant,
} from "../../domain/security/full-user-grant.ts";

export type FullUserGrantAdmission = {
  readonly eligible: boolean;
  readonly reason: string;
  readonly id: string;
  readonly revision: number;
};
export interface FullUserGrantAdmissionPort {
  /** Null means a host-owned declarative/governed binding; full-user bindings require a reference. */
  inspect(capabilityId: string, trust: TrustProjection): FullUserGrantAdmission | null;
}
export type FullUserGrantExpectation = {
  readonly id: string;
  readonly revision: number;
  readonly identity: FullUserGrantIdentityV1;
  readonly actor: string;
  readonly automatic: boolean;
  readonly policyAllows: boolean;
  readonly now: number;
};

/** Consumes host-qualified identities and existing durable references. It cannot create or widen grants. */
export function createFullUserGrantAdmission(
  store: FullUserGrantStore,
  resolve: (capabilityId: string) => FullUserGrantExpectation | null,
): FullUserGrantAdmissionPort {
  return {
    inspect(capabilityId, trust) {
      const expected = resolve(capabilityId);
      if (expected === null) return null;
      const result = (
        eligible: boolean,
        reason: string,
        revision = expected.revision,
      ): FullUserGrantAdmission => ({ eligible, reason, id: expected.id, revision });
      const read = store.get(expected.id);
      if (!read.ok) return result(false, `grant-${read.error.code}`);
      const record = read.value;
      const decision = inspectFullUserGrant(record, {
        ...expected,
        policyAllows:
          expected.policyAllows && expected.identity.policyGeneration === trust.policyGeneration,
        evidenceBinding: trust.evidence.reference,
        trustEligible: trust.eligible && (record === null || record.decidedAt <= expected.now),
      });
      if (
        decision.eligible ||
        record === null ||
        record.state === "revoked" ||
        record.state === "suspended"
      )
        return result(decision.eligible, decision.reason, record?.revision);
      // A stale reference or another actor cannot mutate the newer user's decision.
      if (
        record.actor !== expected.actor ||
        record.revision !== expected.revision ||
        decision.reason === "automatic-grant-required"
      )
        return result(false, decision.reason, record.revision);
      const suspended = store.replace(
        {
          ...record,
          state: "suspended",
          reason: decision.reason,
          revision: record.revision + 1,
          decidedAt: Math.max(record.decidedAt, expected.now),
        },
        record.revision,
      );
      return suspended.ok
        ? result(false, decision.reason, record.revision + 1)
        : result(false, `grant-${suspended.error.code}`, record.revision);
    },
  };
}
