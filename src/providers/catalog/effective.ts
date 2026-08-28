/** Strict codec for immutable effective model-catalog generations. */

import { instant, modelId } from "../../domain/index.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { CatalogProvenance, ModelCatalog } from "../discovery.ts";
import type { ModelCapability } from "../model-capability.ts";
import { parseModelCapability } from "../model-capability-schema.ts";

export type ModelCatalogParseError = {
  readonly kind: "model-catalog";
  readonly code: "invalid-shape" | "duplicate-model" | "invalid-model";
};

function isCatalogProvenance(value: unknown): value is CatalogProvenance {
  return value === "static-config" || value === "remote-discovery";
}

function nullableInstant(value: unknown): ReturnType<typeof instant> | null | undefined {
  return value === null
    ? null
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? instant(value)
      : undefined;
}

export function parseModelCatalog(value: unknown): Result<ModelCatalog, ModelCatalogParseError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err({ kind: "model-catalog", code: "invalid-shape" });
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "expiresAt,fetchedAt,generation,models,provenance" ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 0 ||
    !isCatalogProvenance(record.provenance) ||
    !Array.isArray(record.models) ||
    record.models.length > 512
  ) {
    return err({ kind: "model-catalog", code: "invalid-shape" });
  }
  const fetchedAt = nullableInstant(record.fetchedAt);
  const expiresAt = nullableInstant(record.expiresAt);
  if (fetchedAt === undefined || expiresAt === undefined) {
    return err({ kind: "model-catalog", code: "invalid-shape" });
  }
  const models: ModelCapability[] = [];
  const ids = new Set<string>();
  for (const value of record.models) {
    const parsed = parseModelCapability(value);
    if (!parsed.ok) {
      return err({ kind: "model-catalog", code: "invalid-model" });
    }
    if (ids.has(String(parsed.value.modelId))) {
      return err({ kind: "model-catalog", code: "duplicate-model" });
    }
    ids.add(String(parsed.value.modelId));
    models.push({ ...parsed.value, modelId: modelId.from(String(parsed.value.modelId)) });
  }
  return ok({
    generation: record.generation,
    provenance: record.provenance,
    fetchedAt,
    expiresAt,
    models,
  });
}
