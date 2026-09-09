/** Exact executable authority identity. Parsing or signing this record grants no permission. */
import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import {
  contributionIdentityV1Schema,
  digestSchema,
  EXTENSION_SCOPES,
  generationSchema,
  identityText,
  packageIdentityV1Schema,
  relativePathSchema,
} from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import type { TrustStoreError } from "./ecosystem-trust.ts";

const target = z.strictObject({ os: identityText, arch: identityText, abi: identityText });
const executable = z.strictObject({
  path: relativePathSchema,
  digest: digestSchema,
  format: identityText,
  target,
});
export const fullUserGrantIdentityV1Schema = z
  .strictObject({
    version: z.literal(1),
    package: packageIdentityV1Schema,
    contribution: contributionIdentityV1Schema,
    provenance: z.strictObject({
      publisher: digestSchema.nullable(),
      signingKey: digestSchema.nullable(),
      certificate: digestSchema.nullable(),
      signature: digestSchema.nullable(),
      attestationStatement: digestSchema.nullable(),
      attestationSigner: digestSchema.nullable(),
      transparencyLog: digestSchema.nullable(),
    }),
    descriptorLockDigest: digestSchema,
    operationSchemaDigest: digestSchema,
    configurationSchemaDigest: digestSchema,
    entrypoint: executable.extend({
      id: identityText,
      loaderIdentity: digestSchema,
      argvTemplateDigest: digestSchema,
      cwdPolicyDigest: digestSchema,
      selector: z.literal("most-specific-v1"),
    }),
    helpers: z
      .array(executable.extend({ role: identityText }))
      .max(256)
      .transform((values) =>
        [...values].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      )
      .refine((values) => new Set(values.map((value) => value.path)).size === values.length),
    mode: z.literal("full-user"),
    intendedAccessDigest: digestSchema,
    hostIntegrationDigest: digestSchema,
    ownershipCleanupDigest: digestSchema,
    scope: z.strictObject({
      kind: z.enum(EXTENSION_SCOPES),
      authority: digestSchema,
      workspaceSet: digestSchema.nullable(),
    }),
    platformQualification: digestSchema,
    policyGeneration: generationSchema,
  })
  .refine(
    (value) =>
      value.contribution.owner.kind === "package" &&
      value.contribution.owner.digest === canonicalDigest(value.package),
  );
export type FullUserGrantIdentityV1 = z.infer<typeof fullUserGrantIdentityV1Schema>;
export function fullUserGrantKey(identity: FullUserGrantIdentityV1): string {
  return canonicalDigest(fullUserGrantIdentityV1Schema.parse(identity));
}
export const fullUserGrantRecordSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  revision: z.int().positive(),
  identity: fullUserGrantIdentityV1Schema,
  actor: digestSchema,
  provenanceKey: digestSchema,
  evidenceBinding: digestSchema,
  state: z.enum(["explicit-allowed", "automatic-allowed", "suspended", "revoked"]),
  reason: identityText,
  decidedAt: z.int().nonnegative(),
});
export type FullUserGrantRecord = z.infer<typeof fullUserGrantRecordSchema>;
export interface FullUserGrantStore {
  get(id: string): Result<FullUserGrantRecord | null, TrustStoreError>;
  /** Host user-decision boundary only. No import/configuration/model route may call this. */
  replace(
    record: FullUserGrantRecord,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Result<null, TrustStoreError>;
}
export function inspectFullUserGrant(
  record: FullUserGrantRecord | null,
  expected: {
    identity: FullUserGrantIdentityV1;
    revision: number;
    actor: string;
    evidenceBinding: string;
    policyAllows: boolean;
    trustEligible: boolean;
    automatic: boolean;
  },
) {
  if (record === null) return { eligible: false, reason: "grant-missing" } as const;
  if (!expected.policyAllows) return { eligible: false, reason: "policy-denied" } as const;
  if (
    record.revision !== expected.revision ||
    record.actor !== expected.actor ||
    fullUserGrantKey(record.identity) !== fullUserGrantKey(expected.identity)
  )
    return { eligible: false, reason: "grant-identity-changed" } as const;
  if (!expected.trustEligible || record.evidenceBinding !== expected.evidenceBinding)
    return { eligible: false, reason: "grant-evidence-changed" } as const;
  if (record.state === "revoked" || record.state === "suspended")
    return { eligible: false, reason: record.state } as const;
  if (expected.automatic && record.state !== "automatic-allowed")
    return { eligible: false, reason: "automatic-grant-required" } as const;
  return { eligible: true, reason: record.state } as const;
}
