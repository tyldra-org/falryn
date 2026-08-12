/**
 * Zod boundary for provider profiles.
 *
 * Rejections report path/code only. A scalar where a credential reference
 * belongs is treated as a plaintext secret mistake.
 */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { CREDENTIAL_STORE_KINDS } from "../domain/configuration.ts";
import {
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_CREDENTIAL_LOCATOR_LENGTH,
} from "../domain/credential.ts";
import { modelId, providerId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { DISCOVERY_POLICIES, PROVIDER_ADAPTER_KINDS } from "./adapter-kind.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "./limits.ts";
import type { ProviderProfile } from "./profile.ts";

const credentialReferenceSchema = z
  .strictObject({
    storeKind: z.literal(CREDENTIAL_STORE_KINDS),
    locator: z.string().min(1).max(MAX_CREDENTIAL_LOCATOR_LENGTH),
    consumer: z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH),
    accountLabel: z.union([z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH), z.null()]),
  })
  .nullable();

export const providerProfileSchema = z
  .object({
    profileId: z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
    providerId: brandedString(providerId),
    adapterKind: z.literal(PROVIDER_ADAPTER_KINDS),
    displayName: z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
    endpoint: z.union([z.string().min(1).max(2048), z.null()]),
    credential: credentialReferenceSchema,
    organization: z.union([z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH), z.null()]),
    project: z.union([z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH), z.null()]),
    enabledModels: z.array(brandedString(modelId)).max(128),
    discovery: z.literal(DISCOVERY_POLICIES),
    timeouts: z
      .strictObject({
        connectMs: z.number().int().positive().max(600_000),
        requestMs: z.number().int().positive().max(600_000),
      })
      .strict(),
  })
  .strict();

export type ProviderProfileParseError = {
  readonly kind: "provider-profile";
  readonly issues: readonly CodecIssue[];
};

export function parseProviderProfile(
  value: unknown,
): Result<ProviderProfile, ProviderProfileParseError> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.credential === "string" ||
      typeof record.credential === "number" ||
      typeof record.credential === "boolean"
    ) {
      return err({
        kind: "provider-profile",
        issues: [{ path: "credential", code: "plaintext-credential" }],
      });
    }
  }

  const parsed = providerProfileSchema.safeParse(value);
  if (!parsed.success) {
    return err({ kind: "provider-profile", issues: toCodecIssues(parsed.error) });
  }
  return ok(parsed.data);
}
