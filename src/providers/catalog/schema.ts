/** Strict codec for bundled and user-authored model catalogs. */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../../domain/branded-schema.ts";
import type { CodecIssue } from "../../domain/codec-error.ts";
import { providerId } from "../../domain/identity.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import { PROVIDER_ADAPTER_KINDS } from "../adapter-kind.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "../limits.ts";
import { modelCapabilityDeclarationSchema } from "../model-capability-schema.ts";
import {
  isModelCatalogId,
  MAX_MODELS_PER_CATALOG,
  MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION,
  type ModelCatalogDocument,
} from "./contracts.ts";

export const modelCatalogDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(MODEL_CATALOG_DOCUMENT_SCHEMA_VERSION),
    catalogId: z.string().min(1).max(128).refine(isModelCatalogId, "invalid catalog identity"),
    displayName: z.string().trim().min(1).max(MAX_PROVIDER_METADATA_ENTRY_LENGTH),
    provider: z
      .strictObject({
        providerId: brandedString(providerId),
        adapterKind: z.enum(PROVIDER_ADAPTER_KINDS),
        endpoint: z.union([z.string().url().max(2048), z.null()]),
      })
      .strict(),
    models: z.array(modelCapabilityDeclarationSchema).min(1).max(MAX_MODELS_PER_CATALOG),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    for (const [index, model] of catalog.models.entries()) {
      const id = String(model.modelId);
      if (ids.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "modelId"],
          message: "duplicate model identity",
        });
      }
      ids.add(id);
    }
  });

export type ModelCatalogDocumentParseError = {
  readonly kind: "model-catalog-document";
  readonly issues: readonly CodecIssue[];
};

export function parseModelCatalogDocument(
  value: unknown,
): Result<ModelCatalogDocument, ModelCatalogDocumentParseError> {
  const parsed = modelCatalogDocumentSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "model-catalog-document", issues: toCodecIssues(parsed.error) });
}
