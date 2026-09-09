import { bytesDigest, canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import type {
  TrustDecisionStore,
  TrustObservation,
} from "../../domain/security/ecosystem-trust.ts";
import {
  type PackageProvenance,
  type PackageProvenanceStore,
  type PackageVerification,
  packageProvenanceKey,
  type SignatureVerifier,
  withPackageProvenance,
} from "../../domain/security/package-provenance.ts";
import {
  inspectPackageTrust,
  type PackageTrustResult,
  type TrustRequest,
  trustRequestSchema,
} from "./package-trust.ts";

const MAX_EVIDENCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Produces facts only. Refreshing facts cannot approve a package or execute quarantine itself. */
export function verifyPackageProvenance(
  observation: TrustObservation,
  input: PackageVerification,
  verifier: SignatureVerifier,
  revision: number,
): PackageProvenance {
  const key = packageProvenanceKey(observation);
  const valid = (
    role: "publisher" | "advisory",
    proof:
      | NonNullable<PackageVerification["signature"]>
      | NonNullable<PackageVerification["advisory"]>,
  ) => {
    const selected = input.keys.find(
      (candidate) => candidate.id === proof.keyId && candidate.role === role,
    );
    return (
      selected !== undefined &&
      proof.statement.expiresAt > proof.statement.issuedAt &&
      proof.statement.expiresAt - proof.statement.issuedAt <= MAX_EVIDENCE_LIFETIME_MS &&
      canonicalDigest(proof.statement.subject) === canonicalDigest(observation.subject.identity) &&
      verifier.verify(
        selected.publicKey,
        selected.id,
        new TextEncoder().encode(canonicalJson(proof.statement)),
        proof.signature,
      )
    );
  };
  const signed = input.signature !== null && valid("publisher", input.signature);
  const advisory = input.advisory !== null && valid("advisory", input.advisory);
  const proofTimes = [input.signature?.statement, input.advisory?.statement].filter(
    (value) => value !== undefined,
  );
  const record = {
    version: 1 as const,
    revision,
    key,
    identity: observation.subject.identity,
    sourceOwner: observation.subject.ownership.sourceOwner,
    actor: observation.actor,
    scope: observation.scope,
    publisher: signed ? (input.signature?.statement.publisher ?? null) : null,
    signingKey: signed ? (input.signature?.keyId ?? null) : null,
    signatureDigest: signed
      ? bytesDigest(Buffer.from(input.signature?.signature ?? "", "base64"))
      : null,
    attestationStatement: null,
    attestationSigner: null,
    transparencyLog: null,
    advisoryKey: advisory ? (input.advisory?.keyId ?? null) : null,
    advisorySequence: advisory ? (input.advisory?.statement.sequence ?? 0) : 0,
    advisoryDigest: advisory ? canonicalDigest(input.advisory?.statement) : null,
    advisoryIds: advisory ? (input.advisory?.statement.advisoryIds ?? []) : [],
    authorityDigest: canonicalDigest(
      input.keys
        .map(({ id, role }) => ({ id, role }))
        .sort((a, b) =>
          `${a.role}:${a.id}` < `${b.role}:${b.id}`
            ? -1
            : `${a.role}:${a.id}` > `${b.role}:${b.id}`
              ? 1
              : 0,
        ),
    ),
  };
  return {
    ...record,
    evidence: {
      integrity: signed ? "verified" : "computed",
      signature: input.signature === null ? "unsigned" : signed ? "verified" : "invalid",
      curation: "unavailable",
      advisory:
        input.advisory === null
          ? "unavailable"
          : advisory
            ? input.advisory.statement.status
            : "quarantined",
      observedAt: Math.max(observation.now, ...proofTimes.map((value) => value.issuedAt)),
      expiresAt:
        proofTimes.length === 0 ? null : Math.min(...proofTimes.map((value) => value.expiresAt)),
      reference: canonicalDigest({ ...record, revision: 0 }),
    },
  };
}

export function inspectProvenanceTrust(
  owners: {
    decisions: TrustDecisionStore;
    provenance: PackageProvenanceStore;
    verifier: SignatureVerifier;
  },
  observation: TrustObservation,
  contributions: readonly string[],
  request?: TrustRequest,
  signal?: AbortSignal,
): PackageTrustResult {
  if (signal?.aborted) return { status: "failed", code: "cancelled" };
  if (request !== undefined && !trustRequestSchema.safeParse(request).success)
    return { status: "failed", code: "malformed" };
  const current = owners.provenance.get(packageProvenanceKey(observation));
  if (!current.ok) return { status: "failed", code: current.error.code };
  if (request?.action !== "refresh") {
    const result = inspectPackageTrust(
      owners.decisions,
      withPackageProvenance(observation, current.value),
      contributions,
      request,
      signal,
    );
    return result.status === "failed" ? result : { ...result, provenance: current.value };
  }
  if (request.verification === undefined)
    return { status: "failed", code: "verification-required" };
  const facts = verifyPackageProvenance(
    observation,
    request.verification,
    owners.verifier,
    (current.value?.revision ?? 0) + 1,
  );
  const projected = inspectPackageTrust(
    owners.decisions,
    withPackageProvenance(observation, facts),
    contributions,
  );
  if (projected.status === "failed") return projected;
  const confirmation = canonicalDigest({
    action: "refresh",
    facts: { ...facts, evidence: { ...facts.evidence, observedAt: 0 } },
  });
  if (request.confirmation === undefined)
    return { ...projected, status: "preview", confirmation, provenance: facts };
  if (request.confirmation !== confirmation)
    return { status: "failed", code: "stale-trust-confirmation" };
  const updated = owners.provenance.replace(facts, current.value?.revision ?? 0, signal);
  return updated.ok
    ? { ...projected, status: "applied", confirmation: null, provenance: facts }
    : { status: "failed", code: updated.error.code };
}
