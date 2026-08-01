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

export type { DurableEventStore, StreamHead } from "./event-store.ts";
export {
  createEventStoreShutdownParticipant,
  createSqliteEventStore,
  EVENT_STORE_PARTICIPANT_NAME,
} from "./event-store.ts";
export type { LocalDataService, LocalDataServiceOptions } from "./local-data-service.ts";
export { createLocalDataService, UNCONSTRAINED_RETENTION } from "./local-data-service.ts";
export type { OwnershipRegistry } from "./ownership.ts";
export {
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./ownership.ts";
export type { ProjectionRunner, ProjectionRunnerOptions } from "./projections.ts";
export {
  createProjectionRunner,
  createProjectionShutdownParticipant,
  PROJECTION_PARTICIPANT_NAME,
} from "./projections.ts";
export { MAX_RECONCILED_ENTRIES, reconcileTemporaryIngest } from "./reconciliation.ts";
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
  PRIVATE_DIRECTORY_MODE,
  prepareRoots,
  QUALIFIED_PLATFORM,
  ROOT_ENVIRONMENT_VARIABLES,
  resolveRoots,
  rootChild,
  usableRoots,
} from "./roots.ts";
export {
  EVENTS_TABLE,
  INVOCATIONS_TABLE,
  MIGRATION_0001,
  MODEL_ATTEMPTS_TABLE,
  PRODUCT_SCHEMA_VERSION,
  PRODUCT_TABLES,
  PROJECTION_CURSORS_TABLE,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./schema.ts";
export {
  latestVersion,
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
