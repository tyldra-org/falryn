/** Strict codecs for provider connection configuration and action boundaries. */

import { z } from "zod";

import { toCodecIssues } from "../domain/branded-schema.ts";
import { instant } from "../domain/clock.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  MAX_PROVIDER_CONNECTIONS,
  PROVIDER_AUTH_METHODS,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderConnectionState,
} from "./connection.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "./limits.ts";
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
    schemaVersion: z.literal(PROVIDER_CONNECTION_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    selectedProfileId: z.union([
      z.string().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
      z.null(),
    ]),
    connections: z.array(connectionSchema).max(MAX_PROVIDER_CONNECTIONS),
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
