/** Durable effective model-catalog generations and route bindings. */

import type { Migration } from "../domain/index.ts";

export const MODEL_CATALOG_GENERATIONS_TABLE = "model_catalog_generations";
export const MODEL_CATALOG_ROUTE_BINDINGS_TABLE = "model_catalog_route_bindings";
export const MODEL_CATALOG_SCHEMA_VERSION = 8;

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
  version: 7,
  name: "create-model-catalog-generations",
  statements: [CREATE_MODEL_CATALOG_GENERATIONS, CREATE_MODEL_CATALOG_GENERATIONS_BY_PROVIDER],
  destructive: false,
};

const CREATE_MODEL_CATALOG_ROUTE_BINDINGS = `CREATE TABLE ${MODEL_CATALOG_ROUTE_BINDINGS_TABLE} (
  profile_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  endpoint TEXT,
  destination_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, destination_id, generation),
  FOREIGN KEY (profile_id, generation)
    REFERENCES ${MODEL_CATALOG_GENERATIONS_TABLE} (profile_id, generation)
    ON DELETE RESTRICT,
  CHECK (length(profile_id) > 0),
  CHECK (generation >= 0),
  CHECK (length(provider_id) > 0),
  CHECK (length(adapter_kind) > 0),
  CHECK (endpoint IS NULL OR length(endpoint) > 0),
  CHECK (length(destination_id) > 0),
  CHECK (bound_at >= 0)
) STRICT`;

const CREATE_MODEL_CATALOG_ROUTE_BINDINGS_BY_PROFILE = `CREATE INDEX model_catalog_route_bindings_by_profile
    ON ${MODEL_CATALOG_ROUTE_BINDINGS_TABLE}
    (profile_id, bound_at DESC, generation DESC, destination_id)`;

/** Add exact adapter/destination identity without rewriting migration 0007. */
export const MIGRATION_0008: Migration = {
  version: MODEL_CATALOG_SCHEMA_VERSION,
  name: "bind-model-catalog-generations-to-routes",
  statements: [CREATE_MODEL_CATALOG_ROUTE_BINDINGS, CREATE_MODEL_CATALOG_ROUTE_BINDINGS_BY_PROFILE],
  destructive: false,
};
