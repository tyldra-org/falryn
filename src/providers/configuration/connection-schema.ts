/** Strict codecs for provider connection configuration and action boundaries. */

import { z } from "zod";

import { toCodecIssues } from "../../domain/foundation/branded-schema.ts";
import { instant } from "../../domain/foundation/clock.ts";
import type { CodecIssue } from "../../domain/foundation/codec-error.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import { CREDENTIAL_PART_RESULTS } from "../../domain/security/credential.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "../protocol/limits.ts";
import {
  MAX_PROVIDER_CONNECTIONS,
  MAX_PROVIDER_CREDENTIAL_RETIREMENTS,
  PROVIDER_AUTH_METHODS,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderConnectionState,
} from "./connection.ts";
import { providerProfileSchema } from "./profile-schema.ts";

const instantSchema = z.number().int().nonnegative().transform(instant);

const accountSchema = z
  .strictObject({
    accountId: z.union([z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH), z.null()]),
    displayName: z.union([z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH), z.null()]),
    authMethod: z.literal(PROVIDER_AUTH_METHODS),
    authorizedAt: instantSchema,
    expiresAt: z.union([instantSchema, z.null()]),
  })
  .strict();

const connectionSchema = z
  .strictObject({
    profile: providerProfileSchema,
    account: accountSchema.nullable(),
    updatedAt: instantSchema,
  })
  .strict();

export const providerConnectionStateSchema = z
  .strictObject({
    schemaVersion: z
      .union([z.literal(1), z.literal(PROVIDER_CONNECTION_SCHEMA_VERSION)])
      .transform(
        (): typeof PROVIDER_CONNECTION_SCHEMA_VERSION => PROVIDER_CONNECTION_SCHEMA_VERSION,
      ),
    revision: z.number().int().nonnegative(),
    selectedProfileId: z.union([
      z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
      z.null(),
    ]),
    connections: z.array(connectionSchema).max(MAX_PROVIDER_CONNECTIONS),
    credentialRetirements: z
      .array(
        z.strictObject({
          connection: connectionSchema,
          remoteRequested: z.boolean(),
          status: z.enum([
            "pending",
            "retiring",
            "retirement-unavailable",
            "retirement-failed",
            "retirement-uncertain",
          ]),
          local: z.strictObject({
            result: z.enum(CREDENTIAL_PART_RESULTS),
            code: z.string().max(128).nullable(),
          }),
          remote: z.enum(["revoked", "not-attempted", "failed", "unsupported", "uncertain"]),
        }),
      )
      .max(MAX_PROVIDER_CREDENTIAL_RETIREMENTS)
      .default([]),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    for (const [index, connection] of state.connections.entries()) {
      const id = connection.profile.profileId;
      if (ids.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "profile", "profileId"],
          message: "duplicate profile identity",
        });
      }
      ids.add(id);
    }
    if (state.selectedProfileId !== null && !ids.has(state.selectedProfileId)) {
      context.addIssue({
        code: "custom",
        path: ["selectedProfileId"],
        message: "selected profile is absent",
      });
    }
  });

export type ProviderConnectionStateParseError = {
  readonly kind: "provider-connection-state";
  readonly issues: readonly CodecIssue[];
};

export function parseProviderConnectionState(
  value: unknown,
): Result<ProviderConnectionState, ProviderConnectionStateParseError> {
  const parsed = providerConnectionStateSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "provider-connection-state", issues: toCodecIssues(parsed.error) });
}
