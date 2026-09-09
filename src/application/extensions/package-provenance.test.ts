import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { evaluateTrust } from "../../domain/security/ecosystem-trust.ts";
import {
  packageVerificationSchema,
  withPackageProvenance,
} from "../../domain/security/package-provenance.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { verifyPackageProvenance } from "./package-provenance.ts";
import { signedVerification } from "./provenance-fixtures.ts";
import { trustFixture } from "./trust-fixtures.ts";

test("real Ed25519 verification identifies the selected signer without granting trust or curation", async () => {
  const { observation } = await trustFixture();
  const input = signedVerification(observation);
  expect(packageVerificationSchema.safeParse(input).success).toBe(true);
  const facts = verifyPackageProvenance(observation, input, ed25519PackageVerifier, 1);
  expect(facts.evidence).toMatchObject({
    integrity: "verified",
    signature: "verified",
    curation: "unavailable",
    advisory: "clear",
  });
  expect(evaluateTrust(withPackageProvenance(observation, facts), null)).toMatchObject({
    state: "verified",
    eligible: false,
  });
  expect(JSON.stringify(facts)).not.toContain(input.keys[0]?.publicKey ?? "missing");
  expect(facts.attestationStatement).toBeNull();
  expect(facts.transparencyLog).toBeNull();
  const unsigned = verifyPackageProvenance(
    observation,
    { ...input, signature: null },
    ed25519PackageVerifier,
    2,
  );
  expect(unsigned.evidence).toMatchObject({ integrity: "computed", signature: "unsigned" });
  expect(unsigned.publisher).toBeNull();
});

test("changed bytes, publisher claims, signatures, and key pins cannot retain verification", async () => {
  const { observation } = await trustFixture();
  const input = signedVerification(observation);
  if (input.signature === null) throw new Error("signature");
  const variants = [
    {
      ...input,
      signature: {
        ...input.signature,
        statement: { ...input.signature.statement, publisher: canonicalDigest("transfer") },
      },
    },
    { ...input, signature: { ...input.signature, signature: Buffer.alloc(64).toString("base64") } },
    { ...input, keys: input.keys.map((key) => ({ ...key, publicKey: "not-a-public-key" })) },
    { ...input, keys: [] },
  ];
  for (const variant of variants) {
    const facts = verifyPackageProvenance(observation, variant, ed25519PackageVerifier, 1);
    expect(facts.evidence.signature).toBe("invalid");
    expect(evaluateTrust(withPackageProvenance(observation, facts), null).state).toBe(
      "quarantined",
    );
  }
  const changed = {
    ...observation,
    subject: {
      ...observation.subject,
      identity: {
        ...observation.subject.identity,
        packageDigest: canonicalDigest("changed bytes"),
      },
    },
  };
  expect(
    verifyPackageProvenance(changed, input, ed25519PackageVerifier, 1).evidence.signature,
  ).toBe("invalid");
});

test("expired and future signed facts remain stale offline; missing advisories remain unavailable", async () => {
  const { observation } = await trustFixture();
  for (const lifetime of [
    { issuedAt: 0, expiresAt: 999 },
    { issuedAt: 1001, expiresAt: 2000 },
  ]) {
    const facts = verifyPackageProvenance(
      observation,
      signedVerification(observation, lifetime),
      ed25519PackageVerifier,
      1,
    );
    expect(evaluateTrust(withPackageProvenance(observation, facts), null)).toMatchObject({
      state: "degraded",
      freshness: "stale",
      eligible: false,
      online: false,
    });
  }
  const input = signedVerification(observation);
  expect(
    verifyPackageProvenance(observation, { ...input, advisory: null }, ed25519PackageVerifier, 1)
      .evidence.advisory,
  ).toBe("unavailable");
  expect(
    packageVerificationSchema.safeParse({ ...input, attestation: { verified: true } }).success,
  ).toBe(false);
  expect(
    packageVerificationSchema.safeParse({ ...input, keys: Array(17).fill(input.keys[0]) }).success,
  ).toBe(false);
});
