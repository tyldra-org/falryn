/**
 * Authentication lifecycle for a provider profile.
 *
 * States match the design contract. Snapshots never carry secret bytes —
 * only health metadata and structural failure codes from credential resolution.
 */

import type { Instant } from "../domain/clock.ts";
import type { CredentialFailure, CredentialHealth } from "../domain/credential.ts";
import type { ProviderProfileId } from "./profile.ts";

export const PROVIDER_AUTH_STATES = [
  "unconfigured",
  "resolving",
  "ready",
  "expiring",
  "refreshing",
  "revoked",
  "invalid",
  "unavailable",
] as const;

export type ProviderAuthState = (typeof PROVIDER_AUTH_STATES)[number];

export function isProviderAuthState(value: unknown): value is ProviderAuthState {
  return typeof value === "string" && (PROVIDER_AUTH_STATES as readonly string[]).includes(value);
}

/**
 * Observable authentication snapshot.
 *
 * Safe to log, export, and project: no locator, no secret, no store output.
 */
export type ProviderAuthSnapshot = {
  readonly profileId: ProviderProfileId;
  readonly state: ProviderAuthState;
  readonly consumer: string;
  readonly observedAt: Instant;
  readonly health: CredentialHealth | null;
  /** Structural code when not ready/unconfigured; never store text. */
  readonly code: string | null;
  readonly retryable: boolean;
};

export type ProviderAuthOutcome =
  | { readonly kind: "ready"; readonly snapshot: ProviderAuthSnapshot }
  | { readonly kind: "not-ready"; readonly snapshot: ProviderAuthSnapshot };

export type ProviderRevocationReport = {
  readonly profileId: ProviderProfileId;
  /** Local secret deletion result code from the store adapter. */
  readonly local: "removed" | "not-present" | "failed" | "unsupported" | "not-attempted";
  /**
   * Remote revocation at the provider. Distinct from local deletion so a user
   * never confuses "deleted from keychain" with "revoked at the vendor".
   */
  readonly remote: "revoked" | "not-attempted" | "failed" | "unsupported";
};

export function authStateForCredentialFailure(failure: CredentialFailure): ProviderAuthState {
  switch (failure.status) {
    case "missing":
    case "empty":
      return "unconfigured";
    case "malformed":
      return "invalid";
    case "denied":
      return "invalid";
    case "locked":
    case "unavailable":
    case "unsupported":
    case "timed-out":
      return "unavailable";
    case "cancelled":
      return "unavailable";
    default: {
      const _exhaustive: never = failure.status;
      return _exhaustive;
    }
  }
}
