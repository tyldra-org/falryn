import { afterEach, expect, test } from "bun:test";
import { createCapabilityTrust } from "../../application/extensions/capability-trust.ts";
import { createFullUserGrantAdmission } from "../../application/extensions/full-user-grant.ts";
import {
  inspectProvenanceTrust,
  verifyPackageProvenance,
} from "../../application/extensions/package-provenance.ts";
import { signedVerification } from "../../application/extensions/provenance-fixtures.ts";
import { trustFixture } from "../../application/extensions/trust-fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type FullUserGrantRecord,
  fullUserGrantIdentityV1Schema,
  inspectFullUserGrant,
} from "../../domain/security/full-user-grant.ts";
import { withPackageProvenance } from "../../domain/security/package-provenance.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import {
  createFullUserGrantRepository,
  createPackageProvenanceRepository,
} from "./provenance-repository.ts";
import { createTrustDecisionRepository } from "./trust-repository.ts";

afterEach(removeTemporaryRoots);
test("receipt failure rolls back evidence and recovery retries the same expected revision", async () => {
  const root = await temporaryRoot("falryn-provenance-recovery-");
  const { observation } = await trustFixture();
  const facts = verifyPackageProvenance(
    observation,
    signedVerification(observation),
    ed25519PackageVerifier,
    1,
  );
  const first = await openProductStoreOrThrow(root);
  try {
    first.write((sql) =>
      sql.run(
        "CREATE TRIGGER fail_trust_receipt BEFORE INSERT ON package_trust_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
      ),
    );
    const repository = createPackageProvenanceRepository(first);
    expect(repository.replace(facts, 0).ok).toBe(false);
    expect(repository.get(facts.key)).toMatchObject({ value: null });
    expect(first.read("SELECT * FROM package_trust_receipts")).toMatchObject({ value: [] });
    first.write((sql) => sql.run("DROP TRIGGER fail_trust_receipt"));
  } finally {
    await first.close();
  }
  for (const fault of ["disk-full", "io-failure"] as const) {
    const faulty = await openProductStoreOrThrow(root, {
      faults: { failOperations: { transaction: fault } },
    });
    try {
      expect(createPackageProvenanceRepository(faulty).replace(facts, 0)).toMatchObject({
        error: { code: fault === "io-failure" ? "uncertain" : "unavailable" },
      });
    } finally {
      await faulty.close();
    }
  }
  const recovered = await openProductStoreOrThrow(root);
  try {
    const repository = createPackageProvenanceRepository(recovered);
    expect(repository.get(facts.key)).toMatchObject({ value: null });
    expect(repository.replace(facts, 0).ok).toBe(true);
    const receipts = recovered.read("SELECT record_json FROM package_trust_receipts");
    expect(receipts.ok && receipts.value).toHaveLength(1);
    expect(receipts.ok && receipts.value[0]?.record_json).toBe(JSON.stringify(facts));
  } finally {
    await recovered.close();
  }
});
test("durable refresh confirms exact pins, survives restart, rejects replay and cannot erase revocation", async () => {
  const root = await temporaryRoot("falryn-provenance-");
  const { observation } = await trustFixture();
  const first = await openProductStoreOrThrow(root);
  const owners = {
    decisions: createTrustDecisionRepository(first),
    provenance: createPackageProvenanceRepository(first),
    verifier: ed25519PackageVerifier,
  };
  const request = {
    action: "refresh" as const,
    expiresAt: null,
    verification: signedVerification(observation, { status: "revoked", sequence: 2 }),
  };
  const preview = inspectProvenanceTrust(owners, observation, [], request);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  expect(preview.trust).toMatchObject({ state: "revoked", eligible: false });
  expect(owners.provenance.get(preview.provenance?.key ?? "")).toMatchObject({ value: null });
  const confirmed = { ...request, confirmation: preview.confirmation };
  expect(
    inspectProvenanceTrust(owners, observation, [], confirmed, AbortSignal.abort()),
  ).toMatchObject({ code: "cancelled" });
  expect(inspectProvenanceTrust(owners, observation, [], confirmed).status).toBe("applied");
  expect(inspectProvenanceTrust(owners, observation, [], confirmed)).toMatchObject({
    code: "stale-trust-confirmation",
  });
  await first.close();
  const restarted = await openProductStoreOrThrow(root);
  try {
    const repository = createPackageProvenanceRepository(restarted);
    const facts = verifyPackageProvenance(
      observation,
      request.verification,
      ed25519PackageVerifier,
      2,
    );
    expect(repository.get(facts.key)).toMatchObject({
      value: { revision: 1, evidence: { advisory: "revoked" } },
    });
    for (const input of [
      { ...request.verification, advisory: null },
      signedVerification(observation, { sequence: 1 }),
      signedVerification(observation, { sequence: 2 }),
    ]) {
      expect(
        repository.replace(
          verifyPackageProvenance(observation, input, ed25519PackageVerifier, 2),
          1,
        ),
      ).toMatchObject({ error: { code: "conflict" } });
    }
    const withdrawal = verifyPackageProvenance(
      observation,
      signedVerification(observation, { sequence: 3 }),
      ed25519PackageVerifier,
      2,
    );
    expect(repository.replace(withdrawal, 1).ok).toBe(true);
    expect(restarted.read("SELECT action FROM package_trust_receipts")).toMatchObject({
      value: [{ action: "evidence-refresh" }, { action: "evidence-refresh" }],
    });
    restarted.write((sql) => sql.run("UPDATE package_provenance SET record_json='{}'"));
    expect(repository.get(facts.key)).toMatchObject({ error: { code: "malformed" } });
    expect(repository.replace({ ...withdrawal, revision: 3 }, 2)).toMatchObject({
      error: { code: "malformed" },
    });
  } finally {
    await restarted.close();
  }
});

test("signer refresh invalidates only matching approvals; transaction guard prevents stale approval", async () => {
  const store = await openProductStoreOrThrow(await temporaryRoot("falryn-provenance-approval-"));
  try {
    const { observation } = await trustFixture();
    const provenance = createPackageProvenanceRepository(store);
    const decisions = createTrustDecisionRepository(store);
    const owners = { provenance, decisions, verifier: ed25519PackageVerifier };
    const firstInput = signedVerification(observation);
    const first = verifyPackageProvenance(observation, firstInput, ed25519PackageVerifier, 1);
    expect(provenance.replace(first, 0).ok).toBe(true);
    const request = { action: "approve" as const, expiresAt: 10_000 };
    const preview = inspectProvenanceTrust(owners, observation, [], request);
    if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
    const approved = inspectProvenanceTrust(owners, observation, [], {
      ...request,
      confirmation: preview.confirmation,
    });
    if (approved.status === "failed" || approved.trust.decision === null)
      throw new Error("approve");
    const other = {
      ...observation,
      subject: {
        ...observation.subject,
        identity: { ...observation.subject.identity, packageId: "unrelated" },
      },
    };
    const otherPreview = inspectProvenanceTrust(owners, other, [], request);
    if (otherPreview.status !== "preview" || otherPreview.confirmation === null)
      throw new Error("other");
    inspectProvenanceTrust(owners, other, [], {
      ...request,
      confirmation: otherPreview.confirmation,
    });
    const admission = createCapabilityTrust(
      decisions,
      (id) => (id === "other" ? other : observation),
      provenance,
    );
    expect(admission.inspect("package")?.eligible).toBe(true);
    // Rotate only the publisher key; advisory monotonicity remains intact.
    const rotated = signedVerification(observation, {
      publisher: canonicalDigest("transferred publisher"),
    });
    const refreshed = verifyPackageProvenance(
      observation,
      {
        ...rotated,
        keys: [
          ...rotated.keys.filter((key) => key.role === "publisher"),
          ...firstInput.keys.filter((key) => key.role === "advisory"),
        ],
        advisory: firstInput.advisory,
      },
      ed25519PackageVerifier,
      2,
    );
    expect(provenance.replace(refreshed, 1).ok).toBe(true);
    expect(admission.inspect("package")?.eligible).toBe(false);
    expect(admission.inspect("other")?.eligible).toBe(true);
    expect(
      decisions.replace(approved.trust.decisionKey, 1, { ...approved.trust.decision, revision: 2 }),
    ).toMatchObject({ error: { code: "conflict" } });
  } finally {
    await store.close();
  }
});

test("exact full-user references suspend durably on helper changes, automatic approval needs a separate revision", async () => {
  const root = await temporaryRoot("falryn-full-user-grant-");
  const store = await openProductStoreOrThrow(root);
  const { observation } = await trustFixture();
  const facts = verifyPackageProvenance(
    observation,
    signedVerification(observation),
    ed25519PackageVerifier,
    1,
  );
  const digest = canonicalDigest("fixture");
  const executable = {
    path: "scripts/run.ts",
    digest,
    format: "typescript",
    target: { os: "darwin", arch: "arm64", abi: "bun" },
  };
  const identity = fullUserGrantIdentityV1Schema.parse({
    version: 1,
    package: observation.subject.identity,
    contribution: {
      version: 1,
      owner: { kind: "package", digest: canonicalDigest(observation.subject.identity) },
      nativeKind: "tool",
      namespace: "fixture",
      localId: "run",
      descriptorDigest: digest,
    },
    provenance: {
      publisher: facts.publisher,
      signingKey: facts.signingKey,
      certificate: null,
      signature: facts.signatureDigest,
      attestationStatement: null,
      attestationSigner: null,
      transparencyLog: null,
    },
    descriptorLockDigest: digest,
    operationSchemaDigest: digest,
    configurationSchemaDigest: digest,
    entrypoint: {
      ...executable,
      id: "run",
      loaderIdentity: digest,
      argvTemplateDigest: digest,
      cwdPolicyDigest: digest,
      selector: "most-specific-v1",
    },
    helpers: [{ ...executable, path: "scripts/helper.ts", role: "worker" }],
    mode: "full-user",
    intendedAccessDigest: digest,
    hostIntegrationDigest: digest,
    ownershipCleanupDigest: digest,
    scope: { ...observation.scope, workspaceSet: null },
    platformQualification: digest,
    policyGeneration: observation.policyGeneration,
  });
  const record: FullUserGrantRecord = {
    version: 1,
    id: crypto.randomUUID(),
    revision: 1,
    identity,
    actor: observation.actor,
    provenanceKey: facts.key,
    evidenceBinding: facts.evidence.reference,
    state: "explicit-allowed",
    reason: "user-approved",
    decidedAt: observation.now,
  };
  const changed = canonicalDigest("different-authority");
  for (const next of [
    { ...identity, descriptorLockDigest: changed },
    { ...identity, operationSchemaDigest: changed },
    { ...identity, configurationSchemaDigest: changed },
    { ...identity, entrypoint: { ...identity.entrypoint, loaderIdentity: changed } },
    {
      ...identity,
      entrypoint: {
        ...identity.entrypoint,
        target: { ...identity.entrypoint.target, abi: "other-abi" },
      },
    },
    { ...identity, entrypoint: { ...identity.entrypoint, argvTemplateDigest: changed } },
    { ...identity, entrypoint: { ...identity.entrypoint, cwdPolicyDigest: changed } },
    { ...identity, scope: { ...identity.scope, workspaceSet: changed } },
    { ...identity, intendedAccessDigest: changed },
    { ...identity, hostIntegrationDigest: changed },
    { ...identity, ownershipCleanupDigest: changed },
    { ...identity, platformQualification: changed },
    { ...identity, policyGeneration: 2 },
    { ...identity, provenance: { ...identity.provenance, signingKey: null } },
  ]) {
    expect(
      inspectFullUserGrant(record, {
        identity: next,
        revision: 1,
        actor: record.actor,
        evidenceBinding: record.evidenceBinding,
        policyAllows: true,
        trustEligible: true,
        automatic: false,
      }),
    ).toMatchObject({ eligible: false, reason: "grant-identity-changed" });
  }
  try {
    const provenance = createPackageProvenanceRepository(store);
    const grants = createFullUserGrantRepository(store);
    const decisions = createTrustDecisionRepository(store);
    expect(provenance.replace(facts, 0).ok).toBe(true);
    expect(grants.replace({ ...record, state: "automatic-allowed" }, 0)).toMatchObject({
      error: { code: "conflict" },
    });
    expect(
      grants.replace(
        {
          ...record,
          identity: { ...identity, provenance: { ...identity.provenance, signingKey: digest } },
        },
        0,
      ),
    ).toMatchObject({ error: { code: "conflict" } });
    expect(grants.replace(record, 0).ok).toBe(true);
    const owners = { provenance, decisions, verifier: ed25519PackageVerifier };
    const request = { action: "approve" as const, expiresAt: 10_000 };
    const preview = inspectProvenanceTrust(owners, observation, [], request);
    if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
    inspectProvenanceTrust(owners, observation, [], {
      ...request,
      confirmation: preview.confirmation,
    });
    let expected = {
      id: record.id,
      revision: 1,
      identity,
      actor: record.actor,
      automatic: false,
      policyAllows: true,
      now: 1000,
    };
    const admission = createCapabilityTrust(
      decisions,
      () => observation,
      provenance,
      createFullUserGrantAdmission(grants, () => expected),
    );
    expect(admission.inspect("run")?.eligible).toBe(true);
    expected = { ...expected, automatic: true };
    expect(admission.inspect("run")?.executionGrant).toMatchObject({
      eligible: false,
      reason: "automatic-grant-required",
    });
    expect(grants.get(record.id)).toMatchObject({
      value: { revision: 1, state: "explicit-allowed" },
    });
    expect(grants.replace({ ...record, revision: 2, state: "automatic-allowed" }, 1).ok).toBe(true);
    expected = { ...expected, revision: 2 };
    expect(admission.inspect("run")?.eligible).toBe(true);
    expected = {
      ...expected,
      identity: {
        ...identity,
        helpers: [
          {
            ...executable,
            path: "scripts/helper.ts",
            role: "worker",
            digest: canonicalDigest("changed-helper"),
          },
        ],
      },
    };
    expect(admission.inspect("run")?.executionGrant).toMatchObject({
      eligible: false,
      reason: "grant-identity-changed",
      revision: 3,
    });
    expect(grants.replace({ ...record, revision: 3 }, 2)).toMatchObject({
      error: { code: "conflict" },
    });
    expect(
      store.read(
        "SELECT action FROM package_trust_receipts WHERE subject_id=$id ORDER BY revision",
        { id: record.id },
      ),
    ).toMatchObject({
      value: [
        { action: "explicit-allowed" },
        { action: "automatic-allowed" },
        { action: "suspended" },
      ],
    });
    expect(withPackageProvenance(observation, facts).subject.ownership.publisher).toBe(
      facts.publisher,
    );
  } finally {
    await store.close();
  }
  const restarted = await openProductStoreOrThrow(root);
  try {
    expect(createFullUserGrantRepository(restarted).get(record.id)).toMatchObject({
      value: { state: "suspended", revision: 3 },
    });
  } finally {
    await restarted.close();
  }
});
