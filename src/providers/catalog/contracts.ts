/** Versioned, secret-free model catalog documents. */

import type { ProviderId } from "../../domain/identity.ts";
import type { ProviderAdapterKind } from "../adapter-kind.ts";
import type { ModelCapabilityDeclaration } from "../model-capability.ts";

export const MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_MODEL_CATALOGS_PER_PROFILE = 16;
export const MAX_MODELS_PER_CATALOG = 512;
export const MAX_MODEL_CATALOG_FILE_BYTES = 2 * 1024 * 1024;

export type ModelCatalogId = string;

/**
 * One catalog is bound to one adapter, provider identity, and destination.
 * That prevents capability facts for an official API from being applied to an
 * unrelated OpenAI-compatible endpoint merely because model names overlap.
 */
export type ModelCatalogDocument = {
  readonly schemaVersion: typeof MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION;
  readonly catalogId: ModelCatalogId;
  readonly displayName: string;
  readonly provider: {
    readonly providerId: ProviderId;
    readonly adapterKind: ProviderAdapterKind;
    readonly endpoint: string | null;
  };
  readonly models: readonly ModelCapabilityDeclaration[];
};

export function isModelCatalogId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(value);
}
