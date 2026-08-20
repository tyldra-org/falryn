/**
 * Application boundary for bounded artifact catalog reads (#340).
 */

import {
  type ArtifactCatalog,
  type ArtifactCatalogError,
  type ArtifactRepositoryPort,
  err,
  MAX_ARTIFACT_CATALOG,
  queryArtifactCatalog,
  type Result,
} from "../domain/index.ts";

export type QueryStoredArtifactsInput = {
  readonly limit?: number;
};

export function queryStoredArtifacts(
  artifacts: ArtifactRepositoryPort,
  input: QueryStoredArtifactsInput,
  signal?: AbortSignal,
): Result<ArtifactCatalog, ArtifactCatalogError> {
  const limit = input.limit ?? MAX_ARTIFACT_CATALOG;
  const listed = artifacts.list(MAX_ARTIFACT_CATALOG);
  if (!listed.ok) {
    return err({ kind: "artifact-catalog", code: "malformed", field: "artifacts" });
  }
  return queryArtifactCatalog(listed.value, limit, signal);
}
