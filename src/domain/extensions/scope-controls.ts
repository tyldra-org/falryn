/** Local choices are durable preferences, separate from installation and native authority. */
import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import { canonicalDigest } from "./canonical.ts";
import { CATALOG_LIMITS, catalogAliasSchema } from "./catalog.ts";
import {
  BEHAVIOR_FAMILIES,
  contributionIdentityV1Schema,
  digestSchema,
  EXTENSION_SCOPES,
  generationSchema,
  identityText,
  packageIdentityV1Schema,
} from "./identity.ts";

export const scopeAuthoritySchema = z.strictObject({
  scope: z.enum(EXTENSION_SCOPES),
  id: identityText,
  generation: generationSchema,
});
export type ScopeAuthority = z.infer<typeof scopeAuthoritySchema>;
/** Generation is deliberately excluded so stale-generation records remain inspectable. */
export const scopeAuthorityKeySchema = scopeAuthoritySchema.pick({ scope: true, id: true });
export type ScopeAuthorityKey = z.infer<typeof scopeAuthorityKeySchema>;
export const scopeAuthoritySelectionSchema = z
  .array(scopeAuthorityKeySchema)
  .max(CATALOG_LIMITS.controls);
export const scopeChoiceSchema = z.strictObject({
  enabled: z.boolean(),
  preferred: z.boolean(),
  explicitOnly: z.boolean(),
});
export type ScopeChoice = z.infer<typeof scopeChoiceSchema>;
export const compactContributionSchema = z.strictObject({
  identity: contributionIdentityV1Schema,
  aliases: z.array(catalogAliasSchema).max(CATALOG_LIMITS.aliases),
  family: z.enum(BEHAVIOR_FAMILIES).nullable(),
  effects: z.array(z.enum(["observation", "mutation", "external", "interactive"])).max(4),
  compatibility: z.enum(["compatible", "incompatible"]),
});
export type CompactContribution = z.infer<typeof compactContributionSchema>;
export const scopeControlSchema = z
  .strictObject({
    version: z.literal(1),
    actor: digestSchema,
    authority: scopeAuthoritySchema,
    /** Exact host-supplied root/session/process binding, never a package-authored path. */
    scopeBinding: digestSchema,
    package: packageIdentityV1Schema,
    /** Compact inspection is reusable only under the same runtime compatibility inputs. */
    compatibilityHost: digestSchema,
    installedRevision: z.int().positive(),
    revision: z.int().positive(),
    choice: scopeChoiceSchema,
    contributions: z.array(compactContributionSchema).max(1_024),
    overrides: z
      .array(z.strictObject({ contribution: digestSchema, choice: scopeChoiceSchema }))
      .max(1_024),
  })
  .refine((record) => {
    const owner = canonicalDigest(record.package);
    const identities = record.contributions.map((entry) => canonicalDigest(entry.identity));
    const overrides = record.overrides.map((entry) => entry.contribution);
    return (
      new Set(identities).size === identities.length &&
      new Set(overrides).size === overrides.length &&
      overrides.every((identity) => identities.includes(identity)) &&
      record.contributions.every(
        (entry) =>
          entry.identity.owner.kind === "package" &&
          entry.identity.owner.digest === owner &&
          new Set(entry.aliases).size === entry.aliases.length,
      )
    );
  });
export type ScopeControl = z.infer<typeof scopeControlSchema>;

/** Generations replace a choice under the same exact owner; they do not retarget it by name. */
export function scopeControlKey(
  control: Pick<ScopeControl, "actor" | "authority" | "package">,
): string {
  return canonicalDigest({
    actor: control.actor,
    scope: control.authority.scope,
    authority: control.authority.id,
    package: control.package,
  });
}

/** Hash bounded entries separately: one package's aggregate metadata may exceed canonicalJson's limit. */
export function scopeControlDigest(control: ScopeControl): string {
  return canonicalDigest({
    ...control,
    contributions: control.contributions.map((entry) => canonicalDigest(entry)),
    overrides: control.overrides.map((entry) => canonicalDigest(entry)),
  });
}

export const scopeRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedRevision: generationSchema,
  packageIdentity: digestSchema,
  contribution: digestSchema.optional(),
  choice: scopeChoiceSchema,
  confirmation: digestSchema.optional(),
});
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;
export const scopeReceiptSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().uuid(),
  key: digestSchema,
  fingerprint: digestSchema,
  controlDigest: digestSchema,
  priorRevision: generationSchema,
  revision: z.int().positive(),
  confirmation: digestSchema,
});
export type ScopeReceipt = z.infer<typeof scopeReceiptSchema>;
export type ScopeError = { readonly code: string };
export type ScopeControlStore = {
  get(key: string): Result<ScopeControl | null, ScopeError>;
  /** Select exact authorities before read bounds; omission requests bounded actor-wide inspection. */
  list(
    actor: string,
    authorities?: readonly ScopeAuthorityKey[],
  ): Result<readonly ScopeControl[], ScopeError>;
  operation(id: string): Result<ScopeReceipt | null, ScopeError>;
  /** Commits the choice and receipt together, checking both control and installation revisions. */
  replace(
    control: ScopeControl,
    receipt: ScopeReceipt,
    signal: AbortSignal,
  ): Result<ScopeReceipt, ScopeError>;
};
