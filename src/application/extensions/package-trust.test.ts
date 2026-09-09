import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  evaluateTrust,
  type TrustObservation,
  trustDecisionSchema,
} from "../../domain/security/ecosystem-trust.ts";
import { inspectPackageTrust, MAX_TRUST_APPROVAL_MS } from "./package-trust.ts";
import { memoryTrustStore, trustFixture } from "./trust-fixtures.ts";

test("preview, approval, restart-shaped read, revocation and explicit reapproval share one exact record", async () => {
  const { observation } = await trustFixture();
  const store = memoryTrustStore();
  const request = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(store, observation, [], request);
  expect(preview.status).toBe("preview");
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  expect(preview.trust.state).toBe("unverified");
  const applied = inspectPackageTrust(store, observation, [], {
    ...request,
    confirmation: preview.confirmation,
  });
  expect(applied.status).toBe("applied");
  if (applied.status === "failed") throw new Error(applied.code);
  expect(applied.trust).toMatchObject({
    state: "user-approved",
    eligible: true,
    freshness: "unavailable",
    availability: "unavailable",
    health: "unknown",
    online: false,
  });
  expect(applied.trust.evidence.signature).toBe("unavailable");
  expect(
    inspectPackageTrust(store, observation, [], { ...request, confirmation: preview.confirmation }),
  ).toMatchObject({ status: "failed", code: "stale-trust-confirmation" });
  const revoke = inspectPackageTrust(store, observation, [], { action: "revoke", expiresAt: null });
  if (revoke.status !== "preview" || revoke.confirmation === null) throw new Error("revoke");
  const revoked = inspectPackageTrust(store, observation, [], {
    action: "revoke",
    expiresAt: null,
    confirmation: revoke.confirmation,
  });
  expect(revoked).toMatchObject({
    status: "applied",
    trust: { state: "revoked", eligible: false },
  });
  expect(
    inspectPackageTrust(store, { ...observation, policyGeneration: 2, now: 20_000 }, []),
  ).toMatchObject({ trust: { state: "revoked" } });
  const again = inspectPackageTrust(store, observation, [], request);
  if (again.status !== "preview" || again.confirmation === null) throw new Error("again");
  expect(
    inspectPackageTrust(store, observation, [], { ...request, confirmation: again.confirmation }),
  ).toMatchObject({ trust: { state: "user-approved", decision: { revision: 3 } } });
});

test("independent identity, owner, publisher, policy, actor, scope, expiry and evidence changes invalidate approval", async () => {
  const { observation } = await trustFixture();
  const decision = trustDecisionSchema.parse({
    version: 1,
    subject: observation.subject,
    evidence: observation.evidence,
    policyGeneration: 1,
    actor: observation.actor,
    scope: observation.scope,
    contributions: [],
    revision: 1,
    action: "approve",
    decidedAt: 1_000,
    expiresAt: 10_000,
  });
  const changed: TrustObservation[] = [
    {
      ...observation,
      subject: {
        ...observation.subject,
        identity: { ...observation.subject.identity, packageDigest: canonicalDigest("changed") },
      },
    },
    {
      ...observation,
      subject: {
        ...observation.subject,
        ownership: { sourceOwner: canonicalDigest("new-owner"), publisher: null },
      },
    },
    {
      ...observation,
      subject: {
        ...observation.subject,
        ownership: { sourceOwner: null, publisher: canonicalDigest("new-publisher") },
      },
    },
    { ...observation, policyGeneration: 2 },
    { ...observation, actor: canonicalDigest("other") },
    { ...observation, scope: { kind: "workspace", authority: observation.actor } },
    { ...observation, now: 10_000 },
    { ...observation, now: 999 },
    { ...observation, evidence: { ...observation.evidence, signature: "conflicting" } },
  ];
  for (const next of changed) expect(evaluateTrust(next, decision).eligible).toBe(false);
  expect(evaluateTrust(observation, decision).eligible).toBe(true);
  expect(
    evaluateTrust(
      { ...observation, now: 1_500, evidence: { ...observation.evidence, observedAt: 1_500 } },
      decision,
    ).eligible,
  ).toBe(true);
  // Restoring the exact original bytes is a match only while the original decision remains valid.
  expect(evaluateTrust(observation, decision).state).toBe("user-approved");
});

test("all trust states preserve independent health, availability and verification facts", async () => {
  const { observation } = await trustFixture();
  const cases = [
    ["unknown", { integrity: "unknown" }],
    ["unverified", {}],
    ["verified", { integrity: "verified", signature: "verified" }],
    ["curated", { integrity: "verified", signature: "verified", curation: "verified" }],
    ["quarantined", { integrity: "mismatch" }],
    ["revoked", { advisory: "revoked" }],
    ["degraded", { expiresAt: 999 }],
  ] as const;
  for (const [state, evidence] of cases) {
    const projected = evaluateTrust(
      { ...observation, evidence: { ...observation.evidence, ...evidence } },
      null,
    );
    expect(projected.state).toBe(state);
    expect(projected.eligible).toBe(false);
    expect(projected.health).toBe("unknown");
    expect(projected.availability).toBe("unavailable");
  }
  expect(evaluateTrust({ ...observation, compatibility: "incompatible" }, null).state).toBe(
    "incompatible",
  );
});

test("confirmation binds contributions and evidence; malformed and cancelled requests write nothing", async () => {
  const { observation } = await trustFixture();
  const store = memoryTrustStore();
  const request = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(store, observation, [], request);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  expect(
    inspectPackageTrust(store, observation, [canonicalDigest("different contribution")], {
      ...request,
      confirmation: preview.confirmation,
    }),
  ).toMatchObject({ code: "stale-trust-confirmation" });
  expect(
    inspectPackageTrust(store, observation, [], {
      ...request,
      expiresAt: observation.now + MAX_TRUST_APPROVAL_MS + 1,
    }),
  ).toMatchObject({ code: "invalid-approval-expiry" });
  expect(
    inspectPackageTrust(
      store,
      observation,
      [],
      { ...request, confirmation: preview.confirmation },
      AbortSignal.abort(),
    ),
  ).toMatchObject({ code: "cancelled" });
  expect(inspectPackageTrust(store, observation, [])).toMatchObject({
    trust: { decisionStatus: "absent" },
  });
});

test("a changed source can revoke its prior exact decision; another actor cannot", async () => {
  const { observation } = await trustFixture();
  const store = memoryTrustStore();
  const affected = [canonicalDigest("original-contribution")];
  const approve = { action: "approve" as const, expiresAt: 10_000 };
  const preview = inspectPackageTrust(store, observation, affected, approve);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  inspectPackageTrust(store, observation, affected, {
    ...approve,
    confirmation: preview.confirmation,
  });
  const changed = {
    ...observation,
    subject: {
      ...observation.subject,
      identity: { ...observation.subject.identity, packageDigest: canonicalDigest("new bytes") },
    },
  };
  const revoke = {
    action: "revoke" as const,
    expiresAt: null,
    decisionKey: preview.trust.decisionKey,
  };
  const revocation = inspectPackageTrust(store, changed, [], revoke);
  if (revocation.status !== "preview" || revocation.confirmation === null)
    throw new Error("revocation");
  expect(revocation.affectedContributions).toEqual(affected);
  expect(revocation.trust.subject).toEqual(observation.subject);
  expect(
    inspectPackageTrust(store, { ...changed, actor: canonicalDigest("other actor") }, [], revoke),
  ).toMatchObject({ code: "decision-not-owned" });
  expect(
    inspectPackageTrust(store, changed, [], { ...revoke, confirmation: revocation.confirmation }),
  ).toMatchObject({ trust: { state: "revoked" } });
  expect(inspectPackageTrust(store, observation, affected)).toMatchObject({
    trust: { state: "revoked" },
  });
});
