import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { evaluateTrust } from "../../domain/security/ecosystem-trust.ts";
import type {
  CurationStatement,
  CurationStatus,
} from "../../domain/security/package-evaluation.ts";
import type { PackageProvenance } from "../../domain/security/package-provenance.ts";
import {
  packageVerificationSchema,
  withPackageProvenance,
} from "../../domain/security/package-provenance.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { curatedVerification, curatorReport } from "./evaluation-fixtures.ts";
import {
  curatorEvaluationRecord,
  inspectProvenanceTrust,
  verifyPackageProvenance,
} from "./package-provenance.ts";
import { signedVerification } from "./provenance-fixtures.ts";
import { memoryTrustStore, trustFixture } from "./trust-fixtures.ts";

test("a curator's signed eligible report verifies curation for these exact bytes and grants nothing", async () => {
  const { observation } = await trustFixture();
  const input = curatedVerification(observation);
  expect(packageVerificationSchema.safeParse(input).success).toBe(true);
  const facts = verifyPackageProvenance(observation, input, ed25519PackageVerifier, 1);
  expect(facts.evidence).toMatchObject({
    integrity: "verified",
    signature: "verified",
    curation: "verified",
  });
  expect(facts).toMatchObject({ curationStatus: "verified", curationKey: input.keys[0]?.id });
  expect(evaluateTrust(withPackageProvenance(observation, facts), null)).toMatchObject({
    state: "curated",
    eligible: false,
    decisionStatus: "absent",
  });
  expect(curatorEvaluationRecord(facts, input)).toMatchObject({
    packageId: observation.subject.identity.packageId,
    identityDigest: canonicalDigest(observation.subject.identity),
    curation: { status: "verified", decision: "curated" },
  });
  // Curated evidence expires with its own statement, not with the longer publisher statement.
  const short = verifyPackageProvenance(
    observation,
    curatedVerification(observation, {
      lifetimeMs: 1_000,
      statement: { issuedAt: observation.now, expiresAt: observation.now + 1_000 },
    }),
    ed25519PackageVerifier,
    1,
  );
  expect(short.evidence.expiresAt).toBe(observation.now + 1_000);
});

test("evidence refreshed without a curation proof keeps its earlier shape", async () => {
  const { observation } = await trustFixture();
  const input = signedVerification(observation);
  const facts = verifyPackageProvenance(observation, input, ed25519PackageVerifier, 1);
  expect(Object.keys(facts)).not.toContain("curationStatus");
  expect(Object.keys(facts)).not.toContain("curationKey");
  expect(facts.evidence.curation).toBe("unavailable");
  expect(
    verifyPackageProvenance(observation, { ...input, curation: null }, ed25519PackageVerifier, 1),
  ).toEqual(facts);
});

test("declined, ineligible, misbound, unpinned, tampered and overlong curation never verifies", async () => {
  const { observation } = await trustFixture();
  const changed = {
    ...observation.subject.identity,
    packageDigest: canonicalDigest("changed bytes"),
  };
  const cases: readonly [
    string,
    ReturnType<typeof curatedVerification>,
    CurationStatus,
    boolean,
  ][] = [
    [
      "declined",
      curatedVerification(observation, { statement: { decision: "declined" } }),
      "declined",
      true,
    ],
    [
      "missing tests",
      curatedVerification(observation, {
        statement: {
          report: curatorReport(
            observation.subject.identity,
            { tests: "behavioral-report-unavailable" },
            observation.now - 1,
          ),
        },
      }),
      "ineligible-report",
      true,
    ],
    [
      "observed undeclared effect",
      curatedVerification(observation, {
        statement: {
          report: curatorReport(
            observation.subject.identity,
            { effects: "native-failed" },
            observation.now - 1,
          ),
        },
      }),
      "ineligible-report",
      true,
    ],
    [
      "other bytes",
      curatedVerification(observation, {
        statement: { subject: changed, report: curatorReport(changed, {}, observation.now - 1) },
      }),
      "subject-mismatch",
      false,
    ],
    [
      "key not pinned as curator",
      curatedVerification(observation, { curatorRole: "publisher" }),
      "invalid",
      false,
    ],
    [
      "lifetime over 30 days",
      curatedVerification(observation, {
        statement: { expiresAt: observation.now + 31 * 24 * 60 * 60 * 1_000 },
      }),
      "invalid",
      false,
    ],
  ];
  for (const [name, input, status, retained] of cases) {
    const facts = verifyPackageProvenance(observation, input, ed25519PackageVerifier, 1);
    expect({ name, status: facts.curationStatus, curation: facts.evidence.curation }).toEqual({
      name,
      status,
      curation: "unavailable",
    });
    expect(evaluateTrust(withPackageProvenance(observation, facts), null).state).toBe("verified");
    expect({ name, retained: curatorEvaluationRecord(facts, input) !== null }).toEqual({
      name,
      retained,
    });
  }
  // A report altered after signing no longer matches the signature.
  const signed = curatedVerification(observation);
  if (signed.curation == null) throw new Error("curation");
  const tampered = {
    ...signed,
    curation: {
      ...signed.curation,
      statement: {
        ...signed.curation.statement,
        report: { ...signed.curation.statement.report, limitations: ["sandbox-unavailable"] },
      } as CurationStatement,
    },
  };
  const facts = verifyPackageProvenance(observation, tampered, ed25519PackageVerifier, 1);
  expect(facts).toMatchObject({ curationStatus: "invalid", curationKey: null });
  expect(curatorEvaluationRecord(facts, tampered)).toBeNull();
});

test("a confirmed curation refresh writes evidence and report together, and still needs approval", async () => {
  const { observation } = await trustFixture();
  const decisions = memoryTrustStore();
  let stored: PackageProvenance | null = null;
  const retained: unknown[] = [];
  const owners = {
    decisions,
    verifier: ed25519PackageVerifier,
    provenance: {
      get: () => ok(stored),
      replace(
        record: PackageProvenance,
        revision: number,
        _signal?: AbortSignal,
        evaluation?: unknown,
      ) {
        if ((stored?.revision ?? 0) !== revision) return err({ code: "conflict" as const });
        stored = record;
        if (evaluation !== undefined) retained.push(evaluation);
        return ok(null);
      },
    },
  };
  const verification = curatedVerification(observation);
  const request = { action: "refresh" as const, expiresAt: null, verification };
  const preview = inspectProvenanceTrust(owners, observation, [], request);
  expect(preview).toMatchObject({ status: "preview" });
  expect(retained).toHaveLength(0);
  if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
  const applied = inspectProvenanceTrust(owners, observation, [], {
    ...request,
    confirmation: preview.confirmation,
  });
  expect(applied).toMatchObject({
    status: "applied",
    trust: { state: "curated", eligible: false, decisionStatus: "absent" },
  });
  expect(retained).toHaveLength(1);
  const inspected = inspectProvenanceTrust(owners, observation, []);
  expect(inspected).toMatchObject({
    status: "inspected",
    trust: { state: "curated", eligible: false },
  });
  // Curation does not stand in for the user's decision: approval is still its own revision.
  const approval = { action: "approve" as const, expiresAt: observation.now + 60_000 };
  const approvalPreview = inspectProvenanceTrust(owners, observation, [], approval);
  if (approvalPreview.status !== "preview" || approvalPreview.confirmation === null)
    throw new Error("approval preview");
  expect(
    inspectProvenanceTrust(owners, observation, [], {
      ...approval,
      confirmation: approvalPreview.confirmation,
    }),
  ).toMatchObject({ status: "applied", trust: { state: "user-approved", eligible: true } });
});
