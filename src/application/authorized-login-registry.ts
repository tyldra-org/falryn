/** Immutable-generation registry for provider-authorized login adapters. */

import {
  type AuthorizedLoginMethod,
  type ProviderAuthorizedLoginAdapter,
  type ProviderProfile,
  parseAuthorizedProviderLoginDescriptor,
} from "../providers/index.ts";

export type AuthorizedLoginAdapterBinding = {
  readonly generation: number;
  readonly adapter: ProviderAuthorizedLoginAdapter;
};

export type AuthorizedLoginAdapterResolution =
  | { readonly kind: "available"; readonly binding: AuthorizedLoginAdapterBinding }
  | { readonly kind: "unavailable"; readonly code: string };

export type AuthorizedLoginRegistrySnapshot = {
  readonly generation: number;
  readonly adapters: readonly ProviderAuthorizedLoginAdapter[];
};

export type AuthorizedLoginAdapterRegistry = {
  snapshot(): AuthorizedLoginRegistrySnapshot;
  replace(adapters: readonly ProviderAuthorizedLoginAdapter[]): AuthorizedLoginRegistrySnapshot;
  resolve(
    profile: ProviderProfile,
    method: AuthorizedLoginMethod,
  ): AuthorizedLoginAdapterResolution;
  methods(profile: ProviderProfile): readonly AuthorizedLoginMethod[];
};

export function createAuthorizedLoginAdapterRegistry(
  initial: readonly ProviderAuthorizedLoginAdapter[] = [],
): AuthorizedLoginAdapterRegistry {
  let generation = 1;
  let adapters = validateAdapters(initial);

  const snapshot = (): AuthorizedLoginRegistrySnapshot => ({
    generation,
    adapters,
  });

  return {
    snapshot,
    replace(next) {
      const validated = validateAdapters(next);
      generation += 1;
      adapters = validated;
      return snapshot();
    },
    resolve(profile, method) {
      const currentGeneration = generation;
      const adapter = adapters.find(
        (candidate) =>
          String(candidate.descriptor.providerId) === String(profile.providerId) &&
          candidate.descriptor.adapterKind === profile.adapterKind &&
          candidate.descriptor.methods.includes(method),
      );
      if (adapter === undefined) {
        return { kind: "unavailable", code: "authorized-login-adapter-unavailable" };
      }
      const availability = safeAvailability(adapter, profile);
      return availability.kind === "unavailable"
        ? { kind: "unavailable", code: structuralCode(availability.code) }
        : { kind: "available", binding: { generation: currentGeneration, adapter } };
    },
    methods(profile) {
      const matched = adapters
        .filter(
          (candidate) =>
            String(candidate.descriptor.providerId) === String(profile.providerId) &&
            candidate.descriptor.adapterKind === profile.adapterKind &&
            safeAvailability(candidate, profile).kind === "available",
        )
        .flatMap((candidate) => candidate.descriptor.methods);
      return [...new Set(matched)];
    },
  };
}

function safeAvailability(
  adapter: ProviderAuthorizedLoginAdapter,
  profile: ProviderProfile,
): ReturnType<ProviderAuthorizedLoginAdapter["availability"]> {
  try {
    return adapter.availability(profile);
  } catch {
    return { kind: "unavailable", code: "authorized-login-adapter-threw" };
  }
}

function validateAdapters(
  candidates: readonly ProviderAuthorizedLoginAdapter[],
): readonly ProviderAuthorizedLoginAdapter[] {
  const identities = new Set<string>();
  const routes = new Set<string>();
  const normalized: ProviderAuthorizedLoginAdapter[] = [];
  for (const candidate of candidates) {
    const parsed = parseAuthorizedProviderLoginDescriptor(candidate.descriptor);
    if (!parsed.ok) {
      throw new Error("invalid authorized-login adapter descriptor");
    }
    const descriptor = Object.freeze({
      ...parsed.value,
      methods: Object.freeze([...parsed.value.methods]),
      scopes: Object.freeze([...parsed.value.scopes]),
      callbackModes: Object.freeze([...parsed.value.callbackModes]),
    });
    if (identities.has(descriptor.adapterId)) {
      throw new Error(`duplicate authorized-login adapter: ${descriptor.adapterId}`);
    }
    identities.add(descriptor.adapterId);
    for (const method of descriptor.methods) {
      const route = JSON.stringify([String(descriptor.providerId), descriptor.adapterKind, method]);
      if (routes.has(route)) {
        throw new Error(`duplicate authorized-login route: ${descriptor.adapterId}`);
      }
      routes.add(route);
    }
    assertImplemented(candidate);
    const adapter = snapshotAdapter(candidate, descriptor);
    normalized.push(adapter);
  }
  return Object.freeze(normalized);
}

function snapshotAdapter(
  candidate: ProviderAuthorizedLoginAdapter,
  descriptor: ProviderAuthorizedLoginAdapter["descriptor"],
): ProviderAuthorizedLoginAdapter {
  return Object.freeze({
    descriptor,
    availability: candidate.availability.bind(candidate),
    ...(candidate.beginPkce === undefined
      ? {}
      : { beginPkce: candidate.beginPkce.bind(candidate) }),
    ...(candidate.exchangePkce === undefined
      ? {}
      : { exchangePkce: candidate.exchangePkce.bind(candidate) }),
    ...(candidate.beginDeviceCode === undefined
      ? {}
      : { beginDeviceCode: candidate.beginDeviceCode.bind(candidate) }),
    ...(candidate.pollDeviceCode === undefined
      ? {}
      : { pollDeviceCode: candidate.pollDeviceCode.bind(candidate) }),
    ...(candidate.refresh === undefined ? {} : { refresh: candidate.refresh.bind(candidate) }),
    ...(candidate.revoke === undefined ? {} : { revoke: candidate.revoke.bind(candidate) }),
    ...(candidate.lookupAccount === undefined
      ? {}
      : { lookupAccount: candidate.lookupAccount.bind(candidate) }),
  });
}

function assertImplemented(adapter: ProviderAuthorizedLoginAdapter): void {
  const { descriptor } = adapter;
  if (typeof adapter.availability !== "function") {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks availability`);
  }
  if (
    descriptor.methods.includes("oauth-pkce") &&
    (adapter.beginPkce === undefined || adapter.exchangePkce === undefined)
  ) {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks PKCE methods`);
  }
  if (
    descriptor.methods.includes("device-code") &&
    (adapter.beginDeviceCode === undefined || adapter.pollDeviceCode === undefined)
  ) {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks device-code methods`);
  }
  if (descriptor.refresh && adapter.refresh === undefined) {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks refresh`);
  }
  if (descriptor.revoke && adapter.revoke === undefined) {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks revoke`);
  }
  if (descriptor.accountLookup && adapter.lookupAccount === undefined) {
    throw new Error(`authorized-login adapter ${descriptor.adapterId} lacks account lookup`);
  }
}

function structuralCode(code: string): string {
  return /^[a-z0-9][a-z0-9.-]{0,127}$/u.test(code) ? code : "authorized-login-adapter-unavailable";
}
