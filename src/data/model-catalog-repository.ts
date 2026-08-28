/** Immutable SQLite storage for effective provider catalog generations. */

import {
  err,
  type Instant,
  instant,
  ok,
  type ProviderId,
  type Result,
  type SqliteStorePort,
} from "../domain/index.ts";
import {
  type ModelCatalog,
  type ProviderProfileId,
  parseModelCatalog,
} from "../providers/index.ts";
import { MODEL_CATALOG_GENERATIONS_TABLE } from "./model-catalog-schema.ts";

export type StoredModelCatalogGeneration = {
  readonly profileId: ProviderProfileId;
  readonly providerId: ProviderId;
  readonly catalog: ModelCatalog;
  readonly publishedAt: Instant;
};

export type ModelCatalogGenerationStorageError = {
  readonly code: "conflict" | "malformed" | "unavailable";
};

export type ModelCatalogGenerationRepository = {
  publish(
    generation: StoredModelCatalogGeneration,
  ): Result<"inserted" | "existing", ModelCatalogGenerationStorageError>;
  get(
    profileId: ProviderProfileId,
    generation: number,
  ): Result<StoredModelCatalogGeneration | null, ModelCatalogGenerationStorageError>;
  latest(
    profileId: ProviderProfileId,
  ): Result<StoredModelCatalogGeneration | null, ModelCatalogGenerationStorageError>;
};

function parseStored(row: Record<string, unknown>): StoredModelCatalogGeneration | null {
  if (
    typeof row.profileId !== "string" ||
    row.profileId.length === 0 ||
    typeof row.providerId !== "string" ||
    row.providerId.length === 0 ||
    typeof row.catalogJson !== "string" ||
    typeof row.publishedAt !== "number" ||
    !Number.isSafeInteger(row.publishedAt) ||
    row.publishedAt < 0
  ) {
    return null;
  }
  try {
    const catalog = parseModelCatalog(JSON.parse(row.catalogJson));
    return !catalog.ok
      ? null
      : {
          profileId: row.profileId,
          providerId: row.providerId as ProviderId,
          catalog: catalog.value,
          publishedAt: instant(row.publishedAt),
        };
  } catch {
    return null;
  }
}

export function createModelCatalogGenerationRepository(
  store: SqliteStorePort,
): ModelCatalogGenerationRepository {
  const select = `SELECT profile_id AS profileId, provider_id AS providerId,
      generation AS generation, catalog_json AS catalogJson, published_at AS publishedAt
    FROM ${MODEL_CATALOG_GENERATIONS_TABLE}`;

  const readOne = (
    sql: string,
    bindings: Record<string, string | number>,
  ): Result<StoredModelCatalogGeneration | null, ModelCatalogGenerationStorageError> => {
    const rows = store.read(sql, bindings);
    if (!rows.ok) {
      return err({ code: "unavailable" });
    }
    const row = rows.value[0];
    if (row === undefined) {
      return ok(null);
    }
    const parsed = parseStored(row);
    return parsed === null ? err({ code: "malformed" }) : ok(parsed);
  };

  return {
    publish(record) {
      const catalogJson = JSON.stringify(record.catalog);
      const written = store.write((statements) => {
        const existing = statements.all(
          `SELECT catalog_json AS catalogJson
             FROM ${MODEL_CATALOG_GENERATIONS_TABLE}
            WHERE profile_id = $profileId AND generation = $generation`,
          { profileId: record.profileId, generation: record.catalog.generation },
        )[0];
        if (existing !== undefined) {
          return existing.catalogJson === catalogJson ? "existing" : "conflict";
        }
        statements.run(
          `INSERT INTO ${MODEL_CATALOG_GENERATIONS_TABLE}
            (profile_id, provider_id, generation, catalog_json, published_at)
           VALUES ($profileId, $providerId, $generation, $catalogJson, $publishedAt)`,
          {
            profileId: record.profileId,
            providerId: record.providerId,
            generation: record.catalog.generation,
            catalogJson,
            publishedAt: record.publishedAt,
          },
        );
        return "inserted";
      });
      if (!written.ok) {
        return err({ code: "unavailable" });
      }
      return written.value.value === "conflict"
        ? err({ code: "conflict" })
        : ok(written.value.value);
    },
    get(profileId, generation) {
      return readOne(`${select} WHERE profile_id = $profileId AND generation = $generation`, {
        profileId,
        generation,
      });
    },
    latest(profileId) {
      return readOne(
        `${select} WHERE profile_id = $profileId
          ORDER BY published_at DESC, generation DESC LIMIT 1`,
        { profileId },
      );
    },
  };
}
