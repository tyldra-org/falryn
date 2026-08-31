/**
 * Provider-neutral authorized-login contracts.
 *
 * Provider adapters own endpoint details. Falryn owns attempt identity,
 * PKCE/device-code coordination, bounded interaction, credential placement,
 * refresh, revocation, and safe receipts.
 */

import type { DurationMs, Instant } from "../domain/clock.ts";
import type { ProviderId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "./adapter-kind.ts";
import type { ProviderAccountMetadata, ProviderAuthMethod } from "./connection.ts";
import type { ProviderProfile } from "./profile.ts";

export const AUTHORIZED_LOGIN_SCHEMA_VERSION = 1;
export const AUTHORIZED_LOGIN_METHODS = ["oauth-pkce", "device-code"] as const;
export type AuthorizedLoginMethod = (typeof AUTHORIZED_LOGIN_METHODS)[number];

export const AUTHORIZATION_CALLBACK_MODES = ["loopback", "manual-code"] as const;
export type AuthorizationCallbackMode = (typeof AUTHORIZATION_CALLBACK_MODES)[number];

export const AUTHORIZATION_RECEIPT_OUTCOMES = [
  "authorized",
  "cancelled",
  "denied",
  "timed-out",
  "failed",
] as const;
export type AuthorizationReceiptOutcome = (typeof AUTHORIZATION_RECEIPT_OUTCOMES)[number];

export const MAX_AUTHORIZATION_ID_LENGTH = 128;
export const MAX_AUTHORIZATION_SCOPES = 64;
export const MAX_AUTHORIZATION_SCOPE_LENGTH = 256;
export const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
export const MAX_AUTHORIZATION_CODE_LENGTH = 4_096;
export const MAX_AUTHORIZATION_TOKEN_LENGTH = 65_536;

export type AuthorizedProviderLoginDescriptor = {
  readonly schemaVersion: typeof AUTHORIZED_LOGIN_SCHEMA_VERSION;
  /** Stable implementation identity, independent from a provider profile. */
  readonly adapterId: string;
  readonly providerId: ProviderId;
  readonly adapterKind: ProviderAdapterKind;
  readonly methods: readonly AuthorizedLoginMethod[];
  readonly scopes: readonly string[];
  readonly callbackModes: readonly AuthorizationCallbackMode[];
  /** Exact loopback redirect for providers that do not permit a random port. */
  readonly loopbackRedirectUri: string | null;
  /** Provider-approved redirect used only for manual-code flows. */
  readonly manualRedirectUri: string | null;
  readonly refresh: boolean;
  readonly revoke: boolean;
  readonly accountLookup: boolean;
  /** Reviewed adapter contract revision, not a secret or provider response. */
  readonly revision: string;
};

/** Secret-bearing value stored only inside an approved credential store. */
export type AuthorizedProviderCredential = {
  readonly schemaVersion: typeof AUTHORIZED_LOGIN_SCHEMA_VERSION;
  readonly kind: "authorized-provider";
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string;
  readonly scopes: readonly string[];
  readonly issuedAt: Instant;
  readonly expiresAt: Instant | null;
};

export type ProviderAuthorizationReceipt = {
  readonly schemaVersion: typeof AUTHORIZED_LOGIN_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly adapterId: string;
  readonly adapterGeneration: number;
  readonly providerId: string;
  readonly profileId: string;
  readonly method: AuthorizedLoginMethod;
  readonly startedAt: Instant;
  readonly finishedAt: Instant;
  readonly outcome: AuthorizationReceiptOutcome;
  /** Falryn-owned structural code. Never provider text or credential material. */
  readonly code: string | null;
};

export type ProviderAuthorizationFailure = {
  readonly kind: "failed";
  readonly code: string;
  readonly retryable: boolean;
};

export type AuthorizationCryptoPort = {
  randomBase64Url(bytes: number): string;
  sha256Base64Url(value: string): string;
  equal(left: string, right: string): boolean;
};

export type AuthorizationCallback =
  | { readonly kind: "callback"; readonly state: string; readonly code: string }
  | { readonly kind: "denied"; readonly state: string | null; readonly code: string }
  | { readonly kind: "invalid"; readonly code: string }
  | { readonly kind: "cancelled" };

export type AuthorizationLoopbackSession = {
  readonly redirectUri: string;
  /** Local URL safe for process argv. The provider URL stays inside the listener. */
  prepareBrowserLaunch(authorizationUrl: string): string | null;
  receive(signal: AbortSignal): Promise<AuthorizationCallback>;
  close(): Promise<void>;
};

export type AuthorizationLoopbackPort = {
  listen(input: {
    readonly attemptId: string;
    readonly deadline: Instant;
    readonly fixedRedirectUri: string | null;
    readonly maxHeaderBytes: number;
    readonly maxBodyBytes: number;
    readonly maxRequests: number;
  }): Promise<
    | { readonly kind: "listening"; readonly session: AuthorizationLoopbackSession }
    | { readonly kind: "unavailable"; readonly code: string }
  >;
};

export type AuthorizationBrowserPort = {
  launch(
    localLaunchUri: string,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "opened" } | { readonly kind: "unavailable"; readonly code: string }>;
};

export type AuthorizationInteractionPort = {
  presentLocalLaunchUri(input: {
    readonly providerId: string;
    /** Loopback-local broker URL. Never the provider URL that carries OAuth state. */
    readonly localLaunchUri: string;
  }): Promise<{ readonly kind: "presented" } | { readonly kind: "unavailable" }>;
  requestAuthorizationCode(input: {
    readonly providerId: string;
    /** Transient provider route for a protected UI. It must never enter diagnostics. */
    readonly authorizationUrl: string;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: "submitted"; readonly code: string }
    | { readonly kind: "cancelled" }
    | { readonly kind: "unavailable" }
  >;
  presentDeviceCode(input: {
    readonly providerId: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string | null;
    readonly userCode: string;
  }): Promise<{ readonly kind: "presented" } | { readonly kind: "unavailable" }>;
};

export type AuthorizedProviderLoginHost = {
  readonly crypto: AuthorizationCryptoPort;
  readonly loopback: AuthorizationLoopbackPort;
  readonly browser: AuthorizationBrowserPort;
  readonly interaction: AuthorizationInteractionPort;
};

export type ProviderAuthorizationDenied = {
  readonly kind: "denied";
  readonly code: string;
};

export type ProviderAuthorizationExchangeResult =
  | {
      readonly kind: "authorized";
      readonly credential: AuthorizedProviderCredential;
      readonly account: ProviderAccountMetadata;
    }
  | ProviderAuthorizationDenied
  | ProviderAuthorizationFailure;

export type ProviderPkceStartResult =
  | { readonly kind: "ready"; readonly authorizationUrl: string }
  | ProviderAuthorizationDenied
  | ProviderAuthorizationFailure;

export type ProviderDeviceCodeStartResult =
  | {
      readonly kind: "ready";
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly verificationUriComplete: string | null;
      readonly pollIntervalMs: DurationMs;
      readonly expiresAt: Instant;
    }
  | ProviderAuthorizationDenied
  | ProviderAuthorizationFailure;

export type ProviderDeviceCodePollResult =
  | ProviderAuthorizationExchangeResult
  | { readonly kind: "pending"; readonly retryAfterMs: DurationMs | null }
  | { readonly kind: "slow-down"; readonly retryAfterMs: DurationMs };

export type ProviderRefreshResult =
  | {
      readonly kind: "refreshed";
      readonly credential: AuthorizedProviderCredential;
      readonly account: ProviderAccountMetadata;
    }
  | { readonly kind: "reauthorization-required"; readonly code: string }
  | ProviderAuthorizationFailure;

export type ProviderRemoteRevocationResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly code: string; readonly retryable: boolean };

export type ProviderAuthorizedLoginAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly code: string };

export type ProviderAuthorizedLoginAdapter = {
  readonly descriptor: AuthorizedProviderLoginDescriptor;
  availability(profile: ProviderProfile): ProviderAuthorizedLoginAvailability;
  beginPkce?(
    profile: ProviderProfile,
    input: {
      readonly attemptId: string;
      readonly state: string;
      readonly codeChallenge: string;
      readonly redirectUri: string;
      readonly scopes: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ProviderPkceStartResult>;
  exchangePkce?(
    profile: ProviderProfile,
    input: {
      readonly attemptId: string;
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<ProviderAuthorizationExchangeResult>;
  beginDeviceCode?(
    profile: ProviderProfile,
    input: { readonly attemptId: string; readonly scopes: readonly string[] },
    signal: AbortSignal,
  ): Promise<ProviderDeviceCodeStartResult>;
  pollDeviceCode?(
    profile: ProviderProfile,
    input: { readonly attemptId: string; readonly deviceCode: string },
    signal: AbortSignal,
  ): Promise<ProviderDeviceCodePollResult>;
  refresh?(
    profile: ProviderProfile,
    credential: AuthorizedProviderCredential,
    signal: AbortSignal,
  ): Promise<ProviderRefreshResult>;
  revoke?(
    profile: ProviderProfile,
    credential: AuthorizedProviderCredential,
    signal: AbortSignal,
  ): Promise<ProviderRemoteRevocationResult>;
  lookupAccount?(
    profile: ProviderProfile,
    credential: AuthorizedProviderCredential,
    method: Exclude<ProviderAuthMethod, "api-key">,
    signal: AbortSignal,
  ): Promise<ProviderAccountMetadata | ProviderAuthorizationFailure>;
};
