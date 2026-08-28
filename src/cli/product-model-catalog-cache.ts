/** Disposable normalized cache for provider-reported model catalogs. */

import { createHash } from "node:crypto";
import { rootChild } from "../data/index.ts";
import { type FileSystemPort, isRootUsable, joinPath, type LocalPath } from "../domain/index.ts";
import {
  type DiscoveryOutcome,
  MAX_MODEL_CATALOG_FILE_BYTES,
  type ModelDiscoveryPort,
  type ProviderProfile,
  parseModelCatalog,
} from "../providers/index.ts";
import type { Services } from "./services.ts";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_DIRECTORY = "provider-catalog-downloads";

type CacheEnvelope = {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly providerId: string;
  readonly adapterKind: string;
  readonly endpoint: string | null;
  readonly catalog: unknown;
};

export type ModelCatalogCacheOptions = {
  readonly fileSystem: FileSystemPort;
  cacheRoot(signal: AbortSignal): Promise<LocalPath | null>;
};

function cacheKey(profile: ProviderProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.profileId,
        String(profile.providerId),
        profile.adapterKind,
        profile.endpoint,
      ]),
    )
    .digest("hex");
}

function matchesProfile(value: CacheEnvelope, profile: ProviderProfile): boolean {
  return (
    value.schemaVersion === CACHE_SCHEMA_VERSION &&
    value.profileId === profile.profileId &&
    value.providerId === String(profile.providerId) &&
    value.adapterKind === profile.adapterKind &&
    value.endpoint === profile.endpoint
  );
}

function parseEnvelope(value: unknown, profile: ProviderProfile): DiscoveryOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "adapterKind,catalog,endpoint,profileId,providerId,schemaVersion"
  ) {
    return null;
  }
  const envelope = record as unknown as CacheEnvelope;
  if (!matchesProfile(envelope, profile)) {
    return null;
  }
  const catalog = parseModelCatalog(envelope.catalog);
  return catalog.ok ? { kind: "catalog", catalog: catalog.value } : null;
}

async function readCached(
  options: ModelCatalogCacheOptions,
  profile: ProviderProfile,
  root: LocalPath,
  signal: AbortSignal,
): Promise<DiscoveryOutcome | null> {
  const directory = joinPath(root, CACHE_DIRECTORY);
  const path = directory.ok ? joinPath(directory.value, `${cacheKey(profile)}.json`) : directory;
  if (!path.ok) {
    return null;
  }
  const text = await options.fileSystem.readText(path.value, MAX_MODEL_CATALOG_FILE_BYTES, signal);
  if (!text.ok) {
    return null;
  }
  try {
    return parseEnvelope(JSON.parse(text.value), profile);
  } catch {
    return null;
  }
}

async function writeCached(
  options: ModelCatalogCacheOptions,
  profile: ProviderProfile,
  root: LocalPath,
  outcome: Extract<DiscoveryOutcome, { readonly kind: "catalog" }>,
  signal: AbortSignal,
): Promise<void> {
  const directory = joinPath(root, CACHE_DIRECTORY);
  if (!directory.ok) {
    return;
  }
  const prepared = await options.fileSystem.createDirectory(directory.value, 0o700, signal);
  if (!prepared.ok) {
    return;
  }
  const path = joinPath(directory.value, `${cacheKey(profile)}.json`);
  if (!path.ok) {
    return;
  }
  const envelope: CacheEnvelope = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    profileId: profile.profileId,
    providerId: String(profile.providerId),
    adapterKind: profile.adapterKind,
    endpoint: profile.endpoint,
    catalog: outcome.catalog,
  };
  await options.fileSystem.writeBytes(
    path.value,
    new TextEncoder().encode(JSON.stringify(envelope)),
    signal,
  );
}

/** Uses an unexpired cache before discovery and refreshes it after success. */
export function createCachedModelDiscovery(
  inner: ModelDiscoveryPort,
  options: ModelCatalogCacheOptions,
): ModelDiscoveryPort {
  return {
    async discover(profile, discoveryOptions) {
      const root = await options.cacheRoot(discoveryOptions.signal);
      if (root !== null) {
        const cached = await readCached(options, profile, root, discoveryOptions.signal);
        if (
          cached?.kind === "catalog" &&
          (cached.catalog.expiresAt === null || cached.catalog.expiresAt > discoveryOptions.now)
        ) {
          return cached;
        }
      }
      const discovered = await inner.discover(profile, discoveryOptions);
      if (root !== null && discovered.kind === "catalog") {
        await writeCached(options, profile, root, discovered, discoveryOptions.signal);
      }
      return discovered;
    },
  };
}

/** Product cache-root resolver with the same private-root policy as all local data. */
export function productModelCatalogCacheOptions(services: Services): ModelCatalogCacheOptions {
  return {
    fileSystem: services.fileSystem,
    async cacheRoot(signal) {
      const statuses = await services.localData.prepareRoots(["cache"], signal);
      const status = statuses.find((candidate) => candidate.root === "cache");
      if (
        status === undefined ||
        (!isRootUsable(status) && status.code !== "insecure-permissions")
      ) {
        return null;
      }
      return rootChild(services.localData.layout, "cache");
    },
  };
}
