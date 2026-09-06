/**
 * The local-data area's public entrypoint.
 *
 * This area owns where Falryn's data lives, who owns each part of it, and what
 * removing any part of it means. It depends on `src/domain` ports and on
 * nothing further out: the filesystem and the environment reach it as ports,
 * wired at the composition root, which is what keeps every removal rule
 * testable without a real disk.
 *
 * It owns Falryn's one database through `sqlite-store.ts` — its open sequence,
 * pragmas, migration runner, transaction boundary, and close path — and no
 * artifact bytes and no export format.
 */

export type { ArtifactProvenanceRepository } from "./artifacts/artifact-provenance-repository.ts";
export { createArtifactProvenanceRepository } from "./artifacts/artifact-provenance-repository.ts";
export {
  ARTIFACT_PROVENANCE_SCHEMA_VERSION,
  ARTIFACT_TRANSFORMATIONS_TABLE,
  MIGRATION_0004,
} from "./artifacts/artifact-provenance-schema.ts";
export { createArtifactRepository } from "./artifacts/artifact-repository.ts";
export {
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACTS_TABLE,
  MIGRATION_0002,
} from "./artifacts/artifact-schema.ts";
export type {
  ArtifactStoreOptions,
  DurableArtifactStore,
  StoredBytes,
} from "./artifacts/artifact-store.ts";
export {
  ARTIFACT_PARTICIPANT_NAME,
  createArtifactShutdownParticipant,
  createArtifactStore,
  VERIFICATION_CHUNK_BYTES,
  verifyStoredBytes,
} from "./artifacts/artifact-store.ts";
export type {
  LoomManifestRepository,
  LoomManifestRepositoryOptions,
  LoomManifestStorageError,
} from "./artifacts/loom-manifest-repository.ts";
export { createLoomManifestRepository } from "./artifacts/loom-manifest-repository.ts";
export {
  LOOM_MANIFESTS_TABLE,
  LOOM_SCHEMA_VERSION,
  MIGRATION_0006,
} from "./artifacts/loom-schema.ts";
export { createScratchResourceRepository } from "./artifacts/scratch-resource-repository.ts";
export {
  MIGRATION_0009,
  SCRATCH_RESOURCE_SCHEMA_VERSION,
  SCRATCH_RESOURCES_TABLE,
  SCRATCH_REVISIONS_TABLE,
} from "./artifacts/scratch-resource-schema.ts";
export type { BackupOptions } from "./lifecycle/backup.ts";
export {
  collectLocalDiagnostics,
  createUserBackup,
  inspectUserBackup,
  restoreUserBackup,
} from "./lifecycle/backup.ts";
export type { ExportOptions } from "./lifecycle/export.ts";
export {
  EXPORT_CHUNK_BYTES,
  resolveInventory,
  verifyPackage,
  WRITTEN_SCHEMA_FAMILIES,
  writePackage,
} from "./lifecycle/export.ts";
export type { LocalDataService, LocalDataServiceOptions } from "./lifecycle/local-data-service.ts";
export { createLocalDataService, UNCONSTRAINED_RETENTION } from "./lifecycle/local-data-service.ts";
export type { OwnershipRegistry } from "./lifecycle/ownership.ts";
export {
  ARTIFACTS_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  EXPORTS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./lifecycle/ownership.ts";
export type { ReachabilityGcInputs, ReachabilityGcOptions } from "./lifecycle/reachability-gc.ts";
export {
  computeGcPlanId,
  executeReachabilityGc,
  MAX_GC_EXAMINED_ARTIFACTS,
  MAX_GC_EXAMINED_SESSIONS,
  MAX_GC_EXPORT_PACKAGES,
  parseExportDirectoryEntry,
  planReachabilityGc,
} from "./lifecycle/reachability-gc.ts";
export { MAX_RECONCILED_ENTRIES, reconcileTemporaryIngest } from "./lifecycle/reconciliation.ts";
export type { BeginRunOptions, RecoveryOptions, RunSession } from "./lifecycle/recovery.ts";
export {
  beginRun,
  createRunShutdownParticipant,
  isCompleteRecovery,
  probeCrashSignals,
  RUN_PARTICIPANT_NAME,
  recoverInterruptedWork,
} from "./lifecycle/recovery.ts";
export type { PlanInputs, ResetSelection } from "./lifecycle/removal.ts";
export {
  computePlanId,
  executeRemoval,
  MAX_REMOVAL_DEPTH,
  MAX_REMOVED_ENTRIES,
  planReset,
  planUninstall,
} from "./lifecycle/removal.ts";
export type { RetentionInputs, UsageMeasurement } from "./lifecycle/retention.ts";
export {
  MAX_MEASURED_DEPTH,
  MAX_MEASURED_ENTRIES,
  measureClass,
  measureSubtree,
  owningRoot,
  pathsForClass,
  reportRetention,
} from "./lifecycle/retention.ts";
export type { PlatformInputs, RootResolution, RootResolutionIssue } from "./lifecycle/roots.ts";
export {
  FALLBACK_HOME,
  inspectRoots,
  PRIVATE_DIRECTORY_MODE,
  prepareRoots,
  QUALIFIED_PLATFORM,
  ROOT_ENVIRONMENT_VARIABLES,
  resolveRoots,
  rootChild,
  usableRoots,
} from "./lifecycle/roots.ts";
export type { StorageProbe, StorageProbeOptions } from "./lifecycle/storage-probe.ts";
export { probeStorage } from "./lifecycle/storage-probe.ts";
export type { MemoryRecordRepository } from "./memory/memory-repository.ts";
export {
  createMemoryRecordRepository,
  MAX_DURABLE_MEMORY_RECORDS,
} from "./memory/memory-repository.ts";
export {
  MEMORY_RECORDS_TABLE,
  MEMORY_SCHEMA_VERSION,
  MIGRATION_0005,
} from "./memory/memory-schema.ts";
export type {
  ModelCatalogGenerationRepository,
  ModelCatalogGenerationStorageError,
  StoredModelCatalogGeneration,
} from "./providers/model-catalog-repository.ts";
export { createModelCatalogGenerationRepository } from "./providers/model-catalog-repository.ts";
export {
  MIGRATION_0007,
  MIGRATION_0008,
  MODEL_CATALOG_GENERATIONS_TABLE,
  MODEL_CATALOG_ROUTE_BINDINGS_TABLE,
  MODEL_CATALOG_SCHEMA_VERSION,
} from "./providers/model-catalog-schema.ts";
export type {
  DurableEventStore,
  SqliteEventStoreOptions,
  StreamHead,
} from "./sessions/event-store.ts";
export {
  createEventStoreShutdownParticipant,
  createSqliteEventStore,
  EVENT_STORE_PARTICIPANT_NAME,
} from "./sessions/event-store.ts";
export type { ProjectionRunner, ProjectionRunnerOptions } from "./sessions/projections.ts";
export {
  createProjectionRunner,
  createProjectionShutdownParticipant,
  PROJECTION_PARTICIPANT_NAME,
} from "./sessions/projections.ts";
export {
  createProviderContinuationStateRepository,
  MAX_DURABLE_PROVIDER_CONTINUATIONS,
} from "./sessions/provider-continuation-repository.ts";
export {
  MIGRATION_0010,
  PROVIDER_CONTINUATION_SCHEMA_VERSION,
  PROVIDER_CONTINUATION_STATES_TABLE,
} from "./sessions/provider-continuation-schema.ts";
export type { SessionViewLimits } from "./sessions/repositories.ts";
export {
  applyCompletion,
  createRecordRepositories,
  DEFAULT_SESSION_VIEW_LIMITS,
  readSessionView,
} from "./sessions/repositories.ts";
export { MIGRATION_0003, RUN_SCHEMA_VERSION, RUNS_TABLE } from "./sessions/run-schema.ts";
export type { ImportOptions } from "./sessions/session-replay.ts";
export { forkSession, importPackage, replaySession } from "./sessions/session-replay.ts";
export {
  EVENTS_TABLE,
  INVOCATIONS_TABLE,
  MIGRATION_0001,
  MODEL_ATTEMPTS_TABLE,
  PROJECTION_CURSORS_TABLE,
  RECORD_SCHEMA_VERSION,
  RECORD_TABLES,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./sqlite/schema.ts";
export {
  latestVersion,
  PRODUCT_SCHEMA_VERSION,
  PRODUCT_TABLES,
  PRODUCTION_MIGRATIONS,
  validateMigrationSet,
} from "./sqlite/sqlite-migrations.ts";
export {
  createSqliteShutdownParticipant,
  MIGRATION_TABLE,
  openSqliteStore,
  SQLITE_DATABASE_FILE,
  SQLITE_PARTICIPANT_NAME,
  SQLITE_STATE_OWNERSHIP,
  sqliteDatabasePath,
  storeErrorForFailure,
} from "./sqlite/sqlite-store.ts";
export {
  WORKSPACE_INDEX_GENERATIONS_TABLE,
  WORKSPACE_INDEX_MIGRATION_0001,
  WORKSPACE_INDEX_MIGRATIONS,
  WORKSPACE_INDEX_RECORDS_TABLE,
  WORKSPACE_INDEX_SCHEMA_VERSION,
} from "./workspace/workspace-index-schema.ts";
export type {
  WorkspaceIndexStore,
  WorkspaceIndexStoreOptions,
} from "./workspace/workspace-index-store.ts";
export { openWorkspaceIndexStore } from "./workspace/workspace-index-store.ts";
