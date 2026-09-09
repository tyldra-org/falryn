/** Signed observations are evidence, never user grants or curation decisions. */
import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import { digestSchema, identityText, packageIdentityV1Schema } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import {
  type TrustObservation,
  type TrustStoreError,
  trustEvidenceSchema,
  trustScopeSchema,
} from "./ecosystem-trust.ts";

const time = z.int().nonnegative();
const lifetime = { issuedAt: time, expiresAt: time };
export const packageStatementSchema = z.strictObject({
  type: z.literal("falryn.package-integrity.v1"),
  subject: packageIdentityV1Schema,
  publisher: digestSchema,
  ...lifetime,
});
export const advisoryStatementSchema = z.strictObject({
  type: z.literal("falryn.package-advisory.v1"),
  subject: packageIdentityV1Schema,
  sequence: z.int().positive(),
  status: z.enum(["clear", "quarantined", "revoked"]),
  advisoryIds: z.array(identityText).max(32),
  ...lifetime,
});
const proof = {
  algorithm: z.literal("ed25519"),
  keyId: digestSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
};
/** Keys are selected by the invoking host/user, never obtained from the package being checked. */
export const packageVerificationSchema = z
  .strictObject({
    version: z.literal(1),
    keys: z
      .array(
        z.strictObject({
          id: digestSchema,
          publicKey: z.string().min(1).max(1024),
          role: z.enum(["publisher", "advisory"]),
        }),
      )
      .max(16),
    signature: z.strictObject({ ...proof, statement: packageStatementSchema }).nullable(),
    advisory: z.strictObject({ ...proof, statement: advisoryStatementSchema }).nullable(),
  })
  .refine(
    (input) => new Set(input.keys.map((key) => `${key.role}:${key.id}`)).size === input.keys.length,
  );
export type PackageVerification = z.infer<typeof packageVerificationSchema>;
export interface SignatureVerifier {
  verify(publicKey: string, keyId: string, statement: Uint8Array, signature: string): boolean;
}
export const packageProvenanceSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.int().positive(),
    key: digestSchema,
    identity: packageIdentityV1Schema,
    sourceOwner: digestSchema.nullable(),
    actor: digestSchema,
    scope: trustScopeSchema,
    evidence: trustEvidenceSchema,
    publisher: digestSchema.nullable(),
    signingKey: digestSchema.nullable(),
    signatureDigest: digestSchema.nullable(),
    // Unsupported attestation/transparency formats are explicitly absent.
    attestationStatement: z.null(),
    attestationSigner: z.null(),
    transparencyLog: z.null(),
    advisoryKey: digestSchema.nullable(),
    advisorySequence: z.int().nonnegative(),
    advisoryDigest: digestSchema.nullable(),
    advisoryIds: z.array(identityText).max(32),
    authorityDigest: digestSchema,
  })
  .refine(
    (value) =>
      value.key ===
      canonicalDigest({
        identity: value.identity,
        owner: value.sourceOwner,
        actor: value.actor,
        scope: value.scope,
      }),
  );
export type PackageProvenance = z.infer<typeof packageProvenanceSchema>;
export interface PackageProvenanceStore {
  get(key: string): Result<PackageProvenance | null, TrustStoreError>;
  replace(
    record: PackageProvenance,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Result<null, TrustStoreError>;
}
export function packageProvenanceKey(observation: TrustObservation): string {
  return canonicalDigest({
    identity: observation.subject.identity,
    owner: observation.subject.ownership.sourceOwner,
    actor: observation.actor,
    scope: observation.scope,
  });
}
export function withPackageProvenance(
  observation: TrustObservation,
  record: PackageProvenance | null,
): TrustObservation {
  if (record === null) return observation;
  return {
    ...observation,
    evidence: record.evidence,
    subject: {
      ...observation.subject,
      ownership: { ...observation.subject.ownership, publisher: record.publisher },
    },
  };
}
