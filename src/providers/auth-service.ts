/**
 * Establish and observe provider authentication without retaining secrets.
 *
 * Resolution runs through {@link SecretResolverPort}: the secret is visible only
 * inside the `use` callback long enough to prove presence, then discarded.
 */

import type { ClockPort } from "../domain/clock.ts";
import type { CredentialStorePort, SecretResolverPort } from "../domain/credential.ts";
import {
  authStateForCredentialFailure,
  type ProviderAuthOutcome,
  type ProviderAuthSnapshot,
  type ProviderRevocationReport,
} from "./auth.ts";
import { type ProviderProfile, profileCredentialConsumer } from "./profile.ts";

export type EstablishProviderAuthOptions = {
  readonly profile: ProviderProfile;
  readonly resolver: SecretResolverPort;
  readonly clock: ClockPort;
  readonly signal?: AbortSignal | undefined;
};

function snapshotBase(
  profile: ProviderProfile,
  clock: ClockPort,
): Pick<ProviderAuthSnapshot, "profileId" | "consumer" | "observedAt"> {
  return {
    profileId: profile.profileId,
    consumer: profileCredentialConsumer(profile),
    observedAt: clock.now(),
  };
}

export async function establishProviderAuth(
  options: EstablishProviderAuthOptions,
): Promise<ProviderAuthOutcome> {
  const { profile, resolver, clock } = options;
  const base = snapshotBase(profile, clock);

  if (profile.credential === null) {
    const snapshot: ProviderAuthSnapshot = {
      ...base,
      state: "unconfigured",
      health: null,
      code: "credential-unset",
      retryable: false,
    };
    return { kind: "not-ready", snapshot };
  }

  const reference = profile.credential;

  const resolution = await resolver.resolve(
    {
      reference,
      consumer: reference.consumer,
    },
    async (secret) => {
      // Prove the secret is non-empty without returning it.
      return secret.length > 0;
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  if (resolution.kind === "unresolved") {
    const state = authStateForCredentialFailure(resolution.failure);
    const snapshot: ProviderAuthSnapshot = {
      ...base,
      state,
      health: resolution.failure.health,
      code: resolution.failure.code,
      retryable: resolution.failure.retryable,
    };
    return { kind: "not-ready", snapshot };
  }

  if (!resolution.value) {
    const snapshot: ProviderAuthSnapshot = {
      ...base,
      state: "unconfigured",
      health: resolution.health,
      code: "credential-empty",
      retryable: false,
    };
    return { kind: "not-ready", snapshot };
  }

  const snapshot: ProviderAuthSnapshot = {
    ...base,
    state: "ready",
    health: resolution.health,
    code: null,
    retryable: false,
  };
  return { kind: "ready", snapshot };
}

/**
 * Removes the local secret for a profile credential and reports remote
 * revocation separately. Remote revocation is unsupported until OAuth adapters
 * exist — callers still get an honest split outcome.
 */
export async function removeProviderCredential(options: {
  readonly profile: ProviderProfile;
  readonly stores: readonly CredentialStorePort[];
  readonly signal?: AbortSignal;
}): Promise<ProviderRevocationReport> {
  const { profile, stores } = options;
  if (profile.credential === null) {
    return {
      profileId: profile.profileId,
      local: "not-present",
      remote: "not-attempted",
    };
  }

  const store = stores.find((candidate) => candidate.storeKind === profile.credential?.storeKind);
  if (store === undefined) {
    return {
      profileId: profile.profileId,
      local: "unsupported",
      remote: "not-attempted",
    };
  }

  const local = await store.removeSecret(
    profile.credential,
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  return {
    profileId: profile.profileId,
    local:
      local.result === "removed" ||
      local.result === "not-present" ||
      local.result === "failed" ||
      local.result === "unsupported" ||
      local.result === "not-attempted"
        ? local.result
        : "failed",
    // Provider-side revocation is not implemented; local deletion must not
    // pretend the vendor session was revoked.
    remote: "not-attempted",
  };
}
