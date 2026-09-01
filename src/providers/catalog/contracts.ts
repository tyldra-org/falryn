/** Versioned, secret-free model catalog documents. */

import type { ProviderId } from "../../domain/identity.ts";
import type { ProviderAdapterKind } from "../adapter-kind.ts";
import type { ModelCapabilityDeclaration } from "../model-capability.ts";

export const MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION = 1;
export const MAX_MODEL_CATALOGS_PER_PROFILE = 16;
export const MAX_MODELS_PER_CATALOG = 512;
export const MAX_MODEL_CATALOG_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_CATALOG_SOURCES = 16;

export const MODEL_CATALOG_SOURCE_FACTS = [
  "identity",
  "capabilities",
  "limits",
  "prompt-cache",
] as const;
export type ModelCatalogSourceFact = (typeof MODEL_CATALOG_SOURCE_FACTS)[number];

export const MODEL_CATALOG_SOURCE_KINDS = [
  "provider-documentation",
  "model-author-documentation",
  "sdk-documentation",
  "runtime-observation",
  "independent-research",
  "user-declared",
] as const;
export type ModelCatalogSourceKind = (typeof MODEL_CATALOG_SOURCE_KINDS)[number];

export const MODEL_CATALOG_SOURCE_CONFIDENCE = ["high", "medium", "low", "unknown"] as const;
export type ModelCatalogSourceConfidence = (typeof MODEL_CATALOG_SOURCE_CONFIDENCE)[number];

export type ModelCatalogSource = {
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly facts: readonly ModelCatalogSourceFact[];
  /** What authority produced the resolved page or observation. Search results are not sources. */
  readonly kind: ModelCatalogSourceKind;
  readonly confidence: ModelCatalogSourceConfidence;
};

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
  /** Evidence for non-pricing facts. Every pricing schedule retains its own source. */
  readonly sources: readonly ModelCatalogSource[];
  readonly models: readonly ModelCapabilityDeclaration[];
};

export function isModelCatalogId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(value);
}
