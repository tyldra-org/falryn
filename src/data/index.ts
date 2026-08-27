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

export type { ArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
export { createArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
export {
  ARTIFACT_PROVENANCE_SCHEMA_VERSION,
  ARTIFACT_TRANSFORMATIONS_TABLE,
  MIGRATION_0004,
} from "./artifact-provenance-schema.ts";
export { createArtifactRepository } from "./artifact-repository.ts";
export {
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACTS_TABLE,
  MIGRATION_0002,
} from "./artifact-schema.ts";
export type { ArtifactStoreOptions, DurableArtifactStore, StoredBytes } from "./artifact-store.ts";
export {
  ARTIFACT_PARTICIPANT_NAME,
  createArtifactShutdownParticipant,
  createArtifactStore,
  VERIFICATION_CHUNK_BYTES,
  verifyStoredBytes,
} from "./artifact-store.ts";
export type { BackupOptions } from "./backup.ts";
export {
  collectLocalDiagnostics,
  createUserBackup,
  inspectUserBackup,
  restoreUserBackup,
} from "./backup.ts";
export type { DurableEventStore, SqliteEventStoreOptions, StreamHead } from "./event-store.ts";
export {
  createEventStoreShutdownParticipant,
  createSqliteEventStore,
  EVENT_STORE_PARTICIPANT_NAME,
} from "./event-store.ts";
export type { ExportOptions } from "./export.ts";
export {
  EXPORT_CHUNK_BYTES,
  resolveInventory,
  verifyPackage,
  WRITTEN_SCHEMA_FAMILIES,
  writePackage,
} from "./export.ts";
export type { LocalDataService, LocalDataServiceOptions } from "./local-data-service.ts";
export { createLocalDataService, UNCONSTRAINED_RETENTION } from "./local-data-service.ts";
export type {
  LoomManifestRepository,
  LoomManifestRepositoryOptions,
  LoomManifestStorageError,
} from "./loom-manifest-repository.ts";
export { createLoomManifestRepository } from "./loom-manifest-repository.ts";
export {
  LOOM_MANIFESTS_TABLE,
  LOOM_SCHEMA_VERSION,
  MIGRATION_0006,
} from "./loom-schema.ts";
export type { MemoryRecordRepository } from "./memory-repository.ts";
export {
  createMemoryRecordRepository,
  MAX_DURABLE_MEMORY_RECORDS,
} from "./memory-repository.ts";
export {
  MEMORY_RECORDS_TABLE,
  MEMORY_SCHEMA_VERSION,
  MIGRATION_0005,
} from "./memory-schema.ts";
export type { OwnershipRegistry } from "./ownership.ts";
export {
  ARTIFACTS_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  EXPORTS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./ownership.ts";
export type { ProjectionRunner, ProjectionRunnerOptions } from "./projections.ts";
export {
  createProjectionRunner,
  createProjectionShutdownParticipant,
  PROJECTION_PARTICIPANT_NAME,
} from "./projections.ts";
export type { ReachabilityGcInputs, ReachabilityGcOptions } from "./reachability-gc.ts";
export {
  computeGcPlanId,
  executeReachabilityGc,
  MAX_GC_EXAMINED_ARTIFACTS,
  MAX_GC_EXAMINED_SESSIONS,
  MAX_GC_EXPORT_PACKAGES,
  parseExportDirectoryEntry,
  planReachabilityGc,
} from "./reachability-gc.ts";
export { MAX_RECONCILED_ENTRIES, reconcileTemporaryIngest } from "./reconciliation.ts";
export type { BeginRunOptions, RecoveryOptions, RunSession } from "./recovery.ts";
export {
  beginRun,
  createRunShutdownParticipant,
  isCompleteRecovery,
  probeCrashSignals,
  RUN_PARTICIPANT_NAME,
  recoverInterruptedWork,
} from "./recovery.ts";
export type { PlanInputs, ResetSelection } from "./removal.ts";
export {
  computePlanId,
  executeRemoval,
  MAX_REMOVAL_DEPTH,
  MAX_REMOVED_ENTRIES,
  planReset,
  planUninstall,
} from "./removal.ts";
export type { SessionViewLimits } from "./repositories.ts";
export {
  applyCompletion,
  createRecordRepositories,
  DEFAULT_SESSION_VIEW_LIMITS,
  readSessionView,
} from "./repositories.ts";
export type { RetentionInputs, UsageMeasurement } from "./retention.ts";
export {
  MAX_MEASURED_DEPTH,
  MAX_MEASURED_ENTRIES,
  measureClass,
  measureSubtree,
  owningRoot,
  pathsForClass,
  reportRetention,
} from "./retention.ts";
export type { PlatformInputs, RootResolution, RootResolutionIssue } from "./roots.ts";
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
} from "./roots.ts";
export { MIGRATION_0003, RUN_SCHEMA_VERSION, RUNS_TABLE } from "./run-schema.ts";
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
} from "./schema.ts";
export type { ImportOptions } from "./session-replay.ts";
export { forkSession, importPackage, replaySession } from "./session-replay.ts";
export {
  latestVersion,
  PRODUCT_SCHEMA_VERSION,
  PRODUCT_TABLES,
  PRODUCTION_MIGRATIONS,
  validateMigrationSet,
} from "./sqlite-migrations.ts";
export {
  createSqliteShutdownParticipant,
  MIGRATION_TABLE,
  openSqliteStore,
  SQLITE_DATABASE_FILE,
  SQLITE_PARTICIPANT_NAME,
  SQLITE_STATE_OWNERSHIP,
  sqliteDatabasePath,
  storeErrorForFailure,
} from "./sqlite-store.ts";
export type { StorageProbe, StorageProbeOptions } from "./storage-probe.ts";
export { probeStorage } from "./storage-probe.ts";
export {
  WORKSPACE_INDEX_GENERATIONS_TABLE,
  WORKSPACE_INDEX_MIGRATION_0001,
  WORKSPACE_INDEX_MIGRATIONS,
  WORKSPACE_INDEX_RECORDS_TABLE,
  WORKSPACE_INDEX_SCHEMA_VERSION,
} from "./workspace-index-schema.ts";
export type { WorkspaceIndexStore, WorkspaceIndexStoreOptions } from "./workspace-index-store.ts";
export { openWorkspaceIndexStore } from "./workspace-index-store.ts";
