/**
 * The local-data area's public entrypoint.
 *
 * This area owns where Falryn's data lives, who owns each part of it, and what
 * removing any part of it means. It depends on `src/domain` ports and on
 * nothing further out: the filesystem and the environment reach it as ports,
 * wired at the composition root, which is what keeps every removal rule
 * testable without a real disk.
 *
 * It owns no database, no artifact bytes, and no export format.
 */

export type { LocalDataService, LocalDataServiceOptions } from "./local-data-service.ts";
export { createLocalDataService, UNCONSTRAINED_RETENTION } from "./local-data-service.ts";
export type { OwnershipRegistry } from "./ownership.ts";
export {
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./ownership.ts";
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
