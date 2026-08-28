/** Product loading boundary for user-owned model catalog documents. */

import { parseJsonc } from "../config/index.ts";
import {
  err,
  type FileSystemPort,
  joinPath,
  type LocalPath,
  ok,
  type Result,
} from "../domain/index.ts";
import {
  createStaticModelDiscovery,
  type DiscoveryOutcome,
  isModelCatalogId,
  MAX_MODEL_CATALOG_FILE_BYTES,
  type ModelCapabilityDeclaration,
  type ModelDiscoveryPort,
  type ProviderProfile,
  parseModelCatalogDocument,
} from "../providers/index.ts";

export type UserModelCatalogLoadError = {
  readonly kind: "user-model-catalog";
  readonly code:
    | "invalid-id"
    | "path-unavailable"
    | "file-unavailable"
    | "invalid-jsonc"
    | "invalid-document"
    | "identity-mismatch"
    | "destination-mismatch";
  readonly catalogId: string;
};

export type UserModelCatalogLoaderOptions = {
  readonly fileSystem: FileSystemPort;
  configurationRoot(): Promise<LocalPath>;
};

function normalizedEndpoint(value: string | null): string | null {
  return value?.replace(/\/+$/u, "") ?? null;
}

async function loadOne(
  options: UserModelCatalogLoaderOptions,
  root: LocalPath,
  profile: ProviderProfile,
  catalogId: string,
  signal: AbortSignal,
): Promise<Result<readonly ModelCapabilityDeclaration[], UserModelCatalogLoadError>> {
  if (!isModelCatalogId(catalogId)) {
    return err({ kind: "user-model-catalog", code: "invalid-id", catalogId });
  }
  const path = joinPath(root, "catalogs", `${catalogId}.jsonc`);
  if (!path.ok) {
    return err({ kind: "user-model-catalog", code: "path-unavailable", catalogId });
  }
  const text = await options.fileSystem.readText(path.value, MAX_MODEL_CATALOG_FILE_BYTES, signal);
  if (!text.ok) {
    return err({ kind: "user-model-catalog", code: "file-unavailable", catalogId });
  }
  const json = parseJsonc(text.value);
  if (!json.ok) {
    return err({ kind: "user-model-catalog", code: "invalid-jsonc", catalogId });
  }
  const document = parseModelCatalogDocument(json.value);
  if (!document.ok) {
    return err({ kind: "user-model-catalog", code: "invalid-document", catalogId });
  }
  if (document.value.catalogId !== catalogId) {
    return err({ kind: "user-model-catalog", code: "identity-mismatch", catalogId });
  }
  if (
    document.value.provider.adapterKind !== profile.adapterKind ||
    document.value.provider.providerId !== profile.providerId ||
    normalizedEndpoint(document.value.provider.endpoint) !== normalizedEndpoint(profile.endpoint)
  ) {
    return err({ kind: "user-model-catalog", code: "destination-mismatch", catalogId });
  }
  return ok(document.value.models);
}

export async function loadUserModelCatalogs(
  options: UserModelCatalogLoaderOptions,
  profile: ProviderProfile,
  signal: AbortSignal,
): Promise<Result<readonly ModelCapabilityDeclaration[], UserModelCatalogLoadError>> {
  const catalogIds = profile.catalogs ?? [];
  if (catalogIds.length === 0) {
    return ok([]);
  }
  const root = await options.configurationRoot();
  const merged = new Map<string, ModelCapabilityDeclaration>();
  for (const catalogId of catalogIds) {
    if (signal.aborted) {
      return err({ kind: "user-model-catalog", code: "file-unavailable", catalogId });
    }
    const loaded = await loadOne(options, root, profile, catalogId, signal);
    if (!loaded.ok) {
      return loaded;
    }
    for (const capability of loaded.value) {
      merged.set(String(capability.modelId), capability);
    }
  }
  return ok([...merged.values()]);
}

/**
 * A static discovery port that overlays referenced user catalogs on Falryn's
 * bundled catalog. Explicit profile declarations retain highest precedence.
 */
export function createUserCatalogModelDiscovery(
  options: UserModelCatalogLoaderOptions,
): ModelDiscoveryPort {
  return {
    async discover(profile, discoveryOptions): Promise<DiscoveryOutcome> {
      if (discoveryOptions.signal.aborted) {
        return {
          kind: "failed",
          failure: { kind: "cancelled", code: "discovery-aborted", retryable: false },
        };
      }
      const loaded = await loadUserModelCatalogs(options, profile, discoveryOptions.signal);
      if (!loaded.ok) {
        return {
          kind: "failed",
          failure: {
            kind:
              loaded.error.code === "file-unavailable" || loaded.error.code === "path-unavailable"
                ? "unavailable"
                : "malformed",
            code: `user-catalog-${loaded.error.code}`,
            retryable: false,
          },
        };
      }
      return createStaticModelDiscovery({
        generation: Number(discoveryOptions.now),
        catalogCapabilities: loaded.value,
      }).discover(profile, discoveryOptions);
    },
  };
}
