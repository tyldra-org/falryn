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
  isProviderAdapterKind,
  type ModelCatalog,
  type ProviderAdapterKind,
  type ProviderProfileId,
  parseModelCatalog,
} from "../providers/index.ts";
import {
  MODEL_CATALOG_GENERATIONS_TABLE,
  MODEL_CATALOG_ROUTE_BINDINGS_TABLE,
} from "./model-catalog-schema.ts";

export type StoredModelCatalogGeneration = {
  readonly profileId: ProviderProfileId;
  readonly providerId: ProviderId;
  readonly adapterKind: ProviderAdapterKind;
  readonly endpoint: string | null;
  readonly destinationId: string;
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
    destinationId: string,
    generation: number,
  ): Result<StoredModelCatalogGeneration | null, ModelCatalogGenerationStorageError>;
  latest(
    profileId: ProviderProfileId,
    destinationId: string,
  ): Result<StoredModelCatalogGeneration | null, ModelCatalogGenerationStorageError>;
};

function parseStored(row: Record<string, unknown>): StoredModelCatalogGeneration | null {
  if (
    typeof row.profileId !== "string" ||
    row.profileId.length === 0 ||
    typeof row.providerId !== "string" ||
    row.providerId.length === 0 ||
    !isProviderAdapterKind(row.adapterKind) ||
    (row.endpoint !== null && (typeof row.endpoint !== "string" || row.endpoint.length === 0)) ||
    typeof row.destinationId !== "string" ||
    row.destinationId.length === 0 ||
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
          adapterKind: row.adapterKind,
          endpoint: row.endpoint,
          destinationId: row.destinationId,
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
  const select = `SELECT binding.profile_id AS profileId,
      binding.provider_id AS providerId, binding.adapter_kind AS adapterKind,
      binding.endpoint AS endpoint, binding.destination_id AS destinationId,
      binding.generation AS generation, catalog.catalog_json AS catalogJson,
      binding.bound_at AS publishedAt
    FROM ${MODEL_CATALOG_ROUTE_BINDINGS_TABLE} AS binding
    INNER JOIN ${MODEL_CATALOG_GENERATIONS_TABLE} AS catalog
      ON catalog.profile_id = binding.profile_id
     AND catalog.generation = binding.generation`;

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
        let inserted = false;
        const existingCatalog = statements.all(
          `SELECT provider_id AS providerId, catalog_json AS catalogJson
               FROM ${MODEL_CATALOG_GENERATIONS_TABLE}
              WHERE profile_id = $profileId AND generation = $generation`,
          { profileId: record.profileId, generation: record.catalog.generation },
        )[0];
        if (existingCatalog !== undefined) {
          if (
            existingCatalog.providerId !== record.providerId ||
            existingCatalog.catalogJson !== catalogJson
          ) {
            return "conflict";
          }
        } else {
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
          inserted = true;
        }

        const existingBinding = statements.all(
          `SELECT provider_id AS providerId, adapter_kind AS adapterKind, endpoint AS endpoint
             FROM ${MODEL_CATALOG_ROUTE_BINDINGS_TABLE}
            WHERE profile_id = $profileId
              AND destination_id = $destinationId
              AND generation = $generation`,
          {
            profileId: record.profileId,
            destinationId: record.destinationId,
            generation: record.catalog.generation,
          },
        )[0];
        if (existingBinding !== undefined) {
          return existingBinding.providerId === record.providerId &&
            existingBinding.adapterKind === record.adapterKind &&
            existingBinding.endpoint === record.endpoint
            ? inserted
              ? "inserted"
              : "existing"
            : "conflict";
        }
        statements.run(
          `INSERT INTO ${MODEL_CATALOG_ROUTE_BINDINGS_TABLE}
            (profile_id, generation, provider_id, adapter_kind, endpoint, destination_id, bound_at)
           VALUES ($profileId, $generation, $providerId, $adapterKind, $endpoint, $destinationId, $publishedAt)`,
          {
            profileId: record.profileId,
            generation: record.catalog.generation,
            providerId: record.providerId,
            adapterKind: record.adapterKind,
            endpoint: record.endpoint,
            destinationId: record.destinationId,
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
    get(profileId, destinationId, generation) {
      return readOne(
        `${select} WHERE binding.profile_id = $profileId
          AND binding.destination_id = $destinationId
          AND binding.generation = $generation`,
        { profileId, destinationId, generation },
      );
    },
    latest(profileId, destinationId) {
      return readOne(
        `${select} WHERE binding.profile_id = $profileId
          AND binding.destination_id = $destinationId
          ORDER BY binding.bound_at DESC, binding.generation DESC LIMIT 1`,
        { profileId, destinationId },
      );
    },
  };
}
