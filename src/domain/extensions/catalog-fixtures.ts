import { bytesDigest, canonicalDigest } from "./canonical.ts";
import type { CatalogEntry, CatalogScope } from "./catalog.ts";
import type { CapabilityBindingV1, PackageIdentityV1 } from "./identity.ts";

export function catalogFixture(id = "fixture", scope: CatalogScope = "user"): CatalogEntry {
  const digest = bytesDigest(id);
  const owner: PackageIdentityV1 = {
    version: 1,
    packageId: id,
    packageVersion: "1.0.0",
    sourceCoordinate: {
      kind: "local",
      rootId: bytesDigest("fixture-root"),
      path: "plugin",
      sourceDigest: digest,
    },
    packageDigest: digest,
    manifestDigest: digest,
  };
  const source: CatalogEntry["source"] =
    scope === "builtin"
      ? {
          kind: "builtin",
          owner: {
            version: 1,
            release: "0.0.0",
            buildDigest: digest,
            nativeOwnerId: id,
            catalogGeneration: 1,
          },
        }
      : {
          kind: "package",
          owner,
          activation: {
            version: 1,
            packageIdentityDigest: canonicalDigest(owner),
            scope,
            scopeAuthorityId: bytesDigest(`authority:${scope}`),
            scopeAuthorityGeneration: 1,
            configurationGeneration: 1,
            activationRevision: 1,
            catalogGeneration: 1,
          },
        };
  return {
    source,
    contribution: {
      version: 1,
      owner: { kind: source.kind, digest: canonicalDigest(source.owner) },
      nativeKind: "skill",
      namespace: "fixture",
      localId: id,
      descriptorDigest: digest,
    },
    aliases: ["shared"],
    family: "read",
    effects: ["observation"],
    compatibility: "compatible",
    lifecycle: "current",
    enabled: true,
    preferred: false,
    explicitOnly: false,
    health: "unknown",
    trust: "accepted",
    availability: "unavailable",
    reason: "native-owner-unavailable",
    binding: null,
  };
}

export function boundCatalogFixture(
  id: string,
  changes: Partial<CapabilityBindingV1> = {},
): CatalogEntry {
  const entry = catalogFixture(id, "builtin");
  const digest = bytesDigest("equivalent-native-contract");
  return {
    ...entry,
    availability: "available",
    reason: "native-binding-verified",
    binding: {
      version: 1,
      contributionIdentityDigest: canonicalDigest(entry.contribution),
      nativeRegistryOwner: "fixture-native-owner",
      nativeRegistryGeneration: 1,
      actionId: id,
      family: "read",
      schemaDigest: digest,
      effectDigest: digest,
      authorityDigest: digest,
      resultDigest: digest,
      settlementDigest: digest,
      catalogGeneration: 1,
      ...changes,
    },
  };
}
