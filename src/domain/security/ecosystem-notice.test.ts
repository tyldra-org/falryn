import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../extensions/canonical.ts";
import { packageIdentityV1Schema } from "../extensions/identity.ts";
import {
  deriveEcosystemNotices,
  type EcosystemTrustReason,
  ecosystemNoticeSchema,
  ecosystemTrustReason,
  type NoticeInput,
  noticeAcknowledgementKey,
  noticeAcknowledgementSchema,
  presentNotice,
} from "./ecosystem-notice.ts";
import {
  evaluateTrust,
  type TrustDecision,
  type TrustEvidence,
  type TrustObservation,
} from "./ecosystem-trust.ts";

const digest = (name: string) => canonicalDigest(name);
const identity = packageIdentityV1Schema.parse({
  version: 1,
  packageId: "fixture",
  packageVersion: "1.0.0",
  sourceCoordinate: { kind: "local", rootId: "root", path: "pkg", sourceDigest: digest("source") },
  packageDigest: digest("package"),
  manifestDigest: digest("manifest"),
});
const subject = {
  packageId: "fixture",
  packageVersion: "1.0.0",
  identityDigest: digest("identity"),
  packageDigest: identity.packageDigest,
};
const evidence: TrustEvidence = {
  integrity: "verified",
  signature: "verified",
  curation: "unavailable",
  advisory: "clear",
  observedAt: 100,
  expiresAt: 10_000,
  reference: digest("reference"),
};
const scope = { kind: "user" as const, authority: digest("actor") };
function observation(overrides: Partial<TrustObservation> = {}): TrustObservation {
  return {
    subject: {
      identity,
      ownership: { sourceOwner: digest("owner"), publisher: digest("publisher") },
    },
    evidence,
    policyGeneration: 1,
    scope,
    actor: digest("actor"),
    now: 1_000,
    compatibility: "compatible",
    health: "unknown",
    availability: "unavailable",
    online: false,
    ...overrides,
  };
}
function approval(from: TrustObservation, overrides: Partial<TrustDecision> = {}): TrustDecision {
  return {
    version: 1,
    subject: from.subject,
    evidence: from.evidence,
    policyGeneration: from.policyGeneration,
    actor: from.actor,
    scope: from.scope,
    contributions: [],
    revision: 1,
    action: "approve",
    decidedAt: 500,
    expiresAt: 5_000,
    ...overrides,
  };
}
function input(
  from: TrustObservation,
  decision: TrustDecision | null,
  extra: Partial<NoticeInput> = {},
) {
  return {
    subject,
    trust: evaluateTrust(from, decision),
    advisory: { sequence: 3, ids: ["ADV-2", "ADV-1"], verified: true },
    dependencies: { status: "resolved", degraded: false, digest: digest("dependencies") },
    health: [],
    now: from.now,
    ...extra,
  } satisfies NoticeInput;
}

describe("one trust reason for every consumer", () => {
  test("names the cause of each ineligible projection and nothing for an eligible one", () => {
    const current = observation();
    const decision = approval(current);
    expect(ecosystemTrustReason(evaluateTrust(current, decision))).toBeNull();
    expect(ecosystemTrustReason(null)).toBe("ecosystem-trust-required");
    expect(ecosystemTrustReason(evaluateTrust(current, null))).toBe("ecosystem-trust-required");
    const cases: readonly [EcosystemTrustReason, TrustObservation, TrustDecision | null][] = [
      [
        "ecosystem-trust-revoked",
        observation({ evidence: { ...evidence, advisory: "revoked" } }),
        null,
      ],
      [
        "ecosystem-trust-quarantined",
        observation({ evidence: { ...evidence, integrity: "mismatch" } }),
        null,
      ],
      ["ecosystem-trust-incompatible", observation({ compatibility: "incompatible" }), null],
      ["ecosystem-trust-stale", observation({ now: 10_000 }), decision],
      [
        "ecosystem-trust-expired",
        observation({ now: 6_000 }),
        approval(current, { expiresAt: 5_000 }),
      ],
      [
        "ecosystem-trust-changed",
        observation({ evidence: { ...evidence, advisory: "unavailable" } }),
        decision,
      ],
    ];
    for (const [reason, from, made] of cases)
      expect(ecosystemTrustReason(evaluateTrust(from, made))).toBe(reason);
  });

  test("an eligible approval without its execution grant reports the grant, not trust", () => {
    const current = observation();
    const trust = {
      ...evaluateTrust(current, approval(current)),
      eligible: false,
      executionGrant: { eligible: false, reason: "grant-absent", id: "grant", revision: 1 },
    };
    expect(ecosystemTrustReason(trust)).toBe("ecosystem-grant-required");
  });
});

describe("notice derivation", () => {
  test("an approved, healthy, compatible package has no notices", () => {
    const current = observation();
    expect(deriveEcosystemNotices(input(current, approval(current)))).toEqual([]);
    expect(deriveEcosystemNotices(input(observation(), null))).toEqual([]);
  });

  test("an advisory revocation blocks invocation with the shared reason and bounded evidence", () => {
    const from = observation({ evidence: { ...evidence, advisory: "revoked" } });
    const [notice, ...rest] = deriveEcosystemNotices(input(from, approval(observation())));
    expect(rest.map((entry) => entry.code)).toEqual(["approval-changed"]);
    expect(notice).toMatchObject({
      code: "advisory-revoked",
      kind: "advisory",
      state: "revoked",
      severity: "blocking",
      impact: "invocation-denied",
      reason: "ecosystem-trust-revoked",
      requiredAction: "update-package",
      evidence: { advisory: "revoked", advisorySequence: 3, advisoryIds: ["ADV-1", "ADV-2"] },
    });
    expect(ecosystemNoticeSchema.safeParse(notice).success).toBe(true);
    expect(JSON.stringify(notice)).not.toMatch(
      /signature":"[A-Za-z0-9+/]{86}|publicKey|\/Users\//u,
    );
    expect(notice?.remediation.map((entry) => entry.kind)).toEqual([
      "update-package",
      "rollback-package",
    ]);
  });

  test("an advisory whose proof did not verify is not reported as a signed advisory", () => {
    const from = observation({ evidence: { ...evidence, advisory: "quarantined" } });
    const notices = deriveEcosystemNotices(
      input(from, null, { advisory: { sequence: 0, ids: [], verified: false } }),
    );
    expect(notices.map((entry) => entry.code)).toEqual(["advisory-unverified"]);
  });

  test("identity follows the cause: timestamps and repeated derivation do not change it", () => {
    const from = observation({ evidence: { ...evidence, advisory: "revoked" } });
    const first = deriveEcosystemNotices(input(from, null));
    const later = deriveEcosystemNotices(
      input({ ...from, now: 2_000, evidence: { ...from.evidence, observedAt: 900 } }, null, {
        now: 2_000,
      }),
    );
    expect(later.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    const next = deriveEcosystemNotices(
      input(from, null, { advisory: { sequence: 4, ids: ["ADV-1", "ADV-2"], verified: true } }),
    );
    expect(next[0]?.id).not.toBe(first[0]?.id);
  });

  test("stale offline evidence, expired approval and changed evidence each ask for their own action", () => {
    const current = observation();
    const stale = deriveEcosystemNotices(
      input(observation({ now: 10_000 }), approval(current, { expiresAt: 20_000 })),
    );
    expect(stale.map((entry) => [entry.code, entry.reason, entry.requiredAction])).toEqual([
      ["evidence-stale", "ecosystem-trust-stale", "refresh-evidence"],
    ]);
    const expired = deriveEcosystemNotices(
      input(observation({ now: 6_000 }), approval(current, { expiresAt: 5_000 })),
    );
    expect(expired.map((entry) => [entry.code, entry.requiredAction])).toEqual([
      ["approval-expired", "reapprove"],
    ]);
  });

  test("compatibility, dependencies and health are distinct states; only trust-derived ones deny", () => {
    const current = observation({ compatibility: "incompatible" });
    const notices = deriveEcosystemNotices(
      input(current, null, {
        dependencies: { status: "unresolved", code: "missing-dependency" },
        health: [
          {
            state: "failed",
            code: "health-failed",
            generation: digest("generation"),
            contribution: digest("contribution"),
          },
        ],
      }),
    );
    expect(notices.map((entry) => [entry.code, entry.state, entry.impact])).toEqual([
      ["host-incompatible", "incompatible", "invocation-denied"],
      ["dependencies-unresolved", "unavailable", "reported-only"],
      ["health-failed", "failed", "reported-only"],
    ]);
    expect(notices.find((entry) => entry.kind === "health")?.reason).toBeNull();
  });

  test("a malformed upstream digest degrades the evidence reference instead of failing the read", () => {
    const current = observation();
    const notices = deriveEcosystemNotices(
      input(current, approval(current), {
        dependencies: { status: "resolved", degraded: true, digest: "not-a-digest" },
        health: [{ state: "failed", code: "x", generation: "bad", contribution: "worse" }],
      }),
    );
    expect(notices.map((entry) => entry.code)).toEqual(["dependencies-degraded", "health-failed"]);
    for (const notice of notices)
      expect(ecosystemNoticeSchema.safeParse(notice).success).toBe(true);
    expect(notices[1]?.evidence.healthGeneration).toBeNull();
  });

  test("healthy and non-terminal health records produce no notice; flapping keeps one identity", () => {
    const current = observation();
    const health = (state: string) => ({
      state,
      code: "health-x",
      generation: digest("generation"),
      contribution: digest("contribution"),
    });
    for (const state of ["healthy", "completed", "recovered", "starting", "running"])
      expect(
        deriveEcosystemNotices(input(current, approval(current), { health: [health(state)] })),
      ).toEqual([]);
    const failing = deriveEcosystemNotices(
      input(current, approval(current), { health: [health("failed")] }),
    );
    const again = deriveEcosystemNotices(
      input(current, approval(current), { health: [health("failed")] }),
    );
    expect(again.map((entry) => entry.id)).toEqual(failing.map((entry) => entry.id));
    const uncertain = deriveEcosystemNotices(
      input(current, approval(current), { health: [health("uncertain")] }),
    );
    expect(uncertain[0]?.id).not.toBe(failing[0]?.id);
  });
});

describe("acknowledgement", () => {
  const notice = deriveEcosystemNotices(
    input(observation({ evidence: { ...evidence, advisory: "revoked" } }), null),
  )[0];
  if (notice === undefined) throw new Error("fixture notice");
  const record = {
    version: 1 as const,
    noticeId: notice.id,
    scope,
    revision: 1,
    acknowledgedAt: 1_000,
    expiresAt: 2_000,
  };

  test("hides the presentation while the notice still states the denial", () => {
    const shown = presentNotice(notice, null, 1_500);
    expect(shown).toMatchObject({
      presentation: "shown",
      acknowledgement: { status: "unacknowledged" },
    });
    const hidden = presentNotice(notice, record, 1_500);
    expect(hidden.presentation).toBe("suppressed");
    expect(hidden.notice).toBe(notice);
    expect(hidden.notice.impact).toBe("invocation-denied");
    expect(hidden.notice.reason).toBe("ecosystem-trust-revoked");
  });

  test("expires, and never applies to a different notice", () => {
    expect(presentNotice(notice, record, 2_000)).toMatchObject({
      presentation: "shown",
      acknowledgement: { status: "expired" },
    });
    expect(
      presentNotice(notice, { ...record, noticeId: digest("other") }, 1_500).presentation,
    ).toBe("shown");
  });

  test("the bound lifetime and scope key are fixed by the contract", () => {
    expect(noticeAcknowledgementSchema.safeParse(record).success).toBe(true);
    expect(
      noticeAcknowledgementSchema.safeParse({ ...record, expiresAt: 1_000 + 31 * 86_400_000 })
        .success,
    ).toBe(false);
    expect(noticeAcknowledgementSchema.safeParse({ ...record, expiresAt: 1_000 }).success).toBe(
      false,
    );
    expect(noticeAcknowledgementKey(notice.id, scope)).not.toBe(
      noticeAcknowledgementKey(notice.id, { kind: "session", authority: scope.authority }),
    );
  });
});
