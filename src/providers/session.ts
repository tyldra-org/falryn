/**
 * Public entry for provider profile + auth + discovery in one session view.
 *
 * This is the vertical slice for authentication, configuration, and capability
 * discovery. Streaming adapters and routing consume the resulting session.
 */

import type { ClockPort } from "../domain/clock.ts";
import type { CredentialStorePort, SecretResolverPort } from "../domain/credential.ts";
import type { Result } from "../domain/result.ts";
import type {
  ProviderAuthOutcome,
  ProviderAuthSnapshot,
  ProviderRevocationReport,
} from "./auth.ts";
import { establishProviderAuth, removeProviderCredential } from "./auth-service.ts";
import {
  createStaticModelDiscovery,
  type DiscoveryOutcome,
  discoverModelCatalog,
  type ModelCatalog,
  type ModelDiscoveryPort,
} from "./discovery.ts";
import type { ProviderProfile } from "./profile.ts";
import { type ProviderProfileParseError, parseProviderProfile } from "./profile-schema.ts";

export type ProviderSession = {
  readonly profile: ProviderProfile;
  readonly auth: ProviderAuthSnapshot;
  readonly catalog: ModelCatalog | null;
  readonly discovery: DiscoveryOutcome;
};

export type ProviderSessionPorts = {
  readonly resolver: SecretResolverPort;
  readonly clock: ClockPort;
  readonly stores?: readonly CredentialStorePort[] | undefined;
  readonly staticDiscovery?: ModelDiscoveryPort | undefined;
  readonly remoteDiscovery?: ModelDiscoveryPort | undefined;
};

export type OpenProviderSessionOptions = {
  readonly profile: ProviderProfile | unknown;
  readonly ports: ProviderSessionPorts;
  readonly signal?: AbortSignal | undefined;
};

export type OpenProviderSessionResult =
  | { readonly kind: "opened"; readonly session: ProviderSession }
  | { readonly kind: "invalid-profile"; readonly error: ProviderProfileParseError }
  | { readonly kind: "auth-not-ready"; readonly session: ProviderSession };

function asProfile(
  value: ProviderProfile | unknown,
): Result<ProviderProfile, ProviderProfileParseError> {
  if (
    typeof value === "object" &&
    value !== null &&
    "profileId" in value &&
    "providerId" in value &&
    "adapterKind" in value &&
    "enabledModels" in value
  ) {
    // Trusted in-process profiles still pass through parse so defaults cannot
    // bypass bounds.
  }
  return parseProviderProfile(value);
}

export async function openProviderSession(
  options: OpenProviderSessionOptions,
): Promise<OpenProviderSessionResult> {
  const parsed = asProfile(options.profile);
  if (!parsed.ok) {
    return { kind: "invalid-profile", error: parsed.error };
  }
  const profile = parsed.value;
  const authOutcome: ProviderAuthOutcome = await establishProviderAuth({
    profile,
    resolver: options.ports.resolver,
    clock: options.ports.clock,
    signal: options.signal,
  });

  const staticDiscovery = options.ports.staticDiscovery ?? createStaticModelDiscovery();
  const discovery = await discoverModelCatalog(
    profile,
    {
      staticDiscovery,
      remoteDiscovery: options.ports.remoteDiscovery,
    },
    { signal: options.signal ?? new AbortController().signal, now: options.ports.clock.now() },
  );

  const session: ProviderSession = {
    profile,
    auth: authOutcome.snapshot,
    catalog: discovery.kind === "catalog" ? discovery.catalog : null,
    discovery,
  };

  if (authOutcome.kind === "not-ready") {
    return { kind: "auth-not-ready", session };
  }
  return { kind: "opened", session };
}

export async function revokeProviderSessionCredential(options: {
  readonly profile: ProviderProfile;
  readonly stores: readonly CredentialStorePort[];
  readonly signal?: AbortSignal;
}): Promise<ProviderRevocationReport> {
  return removeProviderCredential(options);
}
