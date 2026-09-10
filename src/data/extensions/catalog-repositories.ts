/** Typed repositories for one catalog composition, all sharing the existing SQLite owner. */
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createPackageProvenanceRepository } from "../security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../security/trust-repository.ts";
import { createRecordRepositories } from "../sessions/repositories.ts";
import { createPackageLifecycleRepository } from "./package-lifecycle-repository.ts";
import { createScopeControlRepository } from "./scope-control-repository.ts";

export function createCatalogRepositories(store: SqliteStorePort) {
  return {
    packages: createPackageLifecycleRepository(store),
    controls: createScopeControlRepository(store),
    decisions: createTrustDecisionRepository(store),
    provenance: createPackageProvenanceRepository(store),
    sessions: createRecordRepositories(store).sessions,
  };
}
export type CatalogRepositories = ReturnType<typeof createCatalogRepositories>;
