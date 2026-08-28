/** Durable effective model-catalog generations added by migration 0007. */

import type { Migration } from "../domain/index.ts";

export const MODEL_CATALOG_GENERATIONS_TABLE = "model_catalog_generations";
export const MODEL_CATALOG_SCHEMA_VERSION = 7;

const CREATE_MODEL_CATALOG_GENERATIONS = `CREATE TABLE ${MODEL_CATALOG_GENERATIONS_TABLE} (
  profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  catalog_json TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, generation),
  CHECK (length(profile_id) > 0),
  CHECK (length(provider_id) > 0),
  CHECK (generation >= 0),
  CHECK (length(catalog_json) > 0),
  CHECK (published_at >= 0)
) STRICT`;

const CREATE_MODEL_CATALOG_GENERATIONS_BY_PROVIDER = `CREATE INDEX model_catalog_generations_by_provider
  ON ${MODEL_CATALOG_GENERATIONS_TABLE}
  (provider_id, published_at DESC, profile_id, generation DESC)`;

export const MIGRATION_0007: Migration = {
  version: MODEL_CATALOG_SCHEMA_VERSION,
  name: "create-model-catalog-generations",
  statements: [CREATE_MODEL_CATALOG_GENERATIONS, CREATE_MODEL_CATALOG_GENERATIONS_BY_PROVIDER],
  destructive: false,
};
