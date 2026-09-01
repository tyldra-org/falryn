/**
 * Durable, secret-free provider connection state.
 *
 * A connection is a profile plus safe account metadata. Authentication bytes
 * never enter this contract; the profile carries only an opaque credential
 * reference. The whole state replaces atomically in configuration so selection
 * cannot point at a profile from another generation.
 */

import type { Instant } from "../domain/clock.ts";
import type { ProviderProfile } from "./profile.ts";

export const PROVIDER_CONNECTION_SCHEMA_VERSION = 1;
export const MAX_PROVIDER_CONNECTIONS = 64;

export const PROVIDER_AUTH_METHODS = ["api-key", "oauth-pkce", "device-code"] as const;
export type ProviderAuthMethod = (typeof PROVIDER_AUTH_METHODS)[number];

/** Safe account facts returned by an authorized provider flow. */
export type ProviderAccountMetadata = {
  readonly accountId: string | null;
  readonly displayName: string | null;
  readonly authMethod: ProviderAuthMethod;
  readonly authorizedAt: Instant;
  readonly expiresAt: Instant | null;
};

export type ProviderConnection = {
  readonly profile: ProviderProfile;
  readonly account: ProviderAccountMetadata | null;
  readonly updatedAt: Instant;
};

export type ProviderConnectionState = {
  readonly schemaVersion: typeof PROVIDER_CONNECTION_SCHEMA_VERSION;
  /** Monotonic inside this value; file revision still guards concurrent writes. */
  readonly revision: number;
  readonly selectedProfileId: string | null;
  readonly connections: readonly ProviderConnection[];
};
