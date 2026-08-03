/**
 * The one surface outer layers use for local data.
 *
 * Layout, class registration, retention reporting, removal planning, guarded
 * execution, and startup reconciliation share a path model and a plan
 * structure, so they share an entry point. The service holds no filesystem
 * knowledge of its own: it is handed a `FileSystemPort` and an
 * `EnvironmentPort`, which is what lets every rule below be tested without
 * touching a real disk.
 */

import type {
  EnvironmentPort,
  FileSystemPort,
  LocalDataPlatform,
  LocalDataRoot,
  LocalPath,
  OwnershipClass,
  OwnershipRegistration,
  ReconciliationReport,
  RegistrationError,
  RemovalConfirmation,
  RemovalOutcome,
  RemovalPlan,
  RemovalRefusal,
  Result,
  RetentionPolicy,
  RetentionReport,
  RootInspection,
  RootLayout,
  RootStatus,
} from "../domain/index.ts";
import { createOwnershipRegistry, type OwnershipRegistry } from "./ownership.ts";
import { reconcileTemporaryIngest } from "./reconciliation.ts";
import {
  executeRemoval,
  type PlanInputs,
  planReset,
  planUninstall,
  type ResetSelection,
} from "./removal.ts";
import { reportRetention } from "./retention.ts";
import { inspectRoots, prepareRoots, type RootResolution, resolveRoots } from "./roots.ts";

/** A policy that constrains nothing, for a caller that has no configuration. */
export const UNCONSTRAINED_RETENTION: RetentionPolicy = { byClass: {}, totalMaxBytes: null };

export type LocalDataServiceOptions = {
  readonly fileSystem: FileSystemPort;
  readonly environment: EnvironmentPort;
  readonly platform: LocalDataPlatform;
  readonly home: LocalPath;
};

export type LocalDataService = {
  readonly layout: RootLayout;
  /** Overrides that could not be used, with the reason each was rejected. */
  readonly resolutionIssues: RootResolution["issues"];

  /** Creates exactly the roots the caller needs, and reports what it found. */
  prepareRoots(
    required: readonly LocalDataRoot[],
    signal?: AbortSignal,
  ): Promise<readonly RootStatus[]>;

  /**
   * Reports whether each declared root can hold data, creating nothing.
   *
   * The read-only sibling of {@link LocalDataService.prepareRoots}, declared
   * beside it so a diagnostic reaches it through this surface rather than
   * authoring a filesystem rule of its own.
   */
  inspectRoots(signal?: AbortSignal): Promise<readonly RootInspection[]>;

  register(registration: OwnershipRegistration): Result<null, RegistrationError>;
  registrations(): readonly OwnershipRegistration[];
  unregistered(): readonly OwnershipClass[];

  /**
   * Measures every registered class against a policy.
   *
   * The policy comes from configuration, which is read after roots exist —
   * which is why this takes it as an argument rather than reaching for it.
   */
  reportRetention(policy?: RetentionPolicy, signal?: AbortSignal): Promise<RetentionReport>;

  planReset(selection: ResetSelection, signal?: AbortSignal): Promise<RemovalPlan>;
  planUninstall(signal?: AbortSignal): Promise<RemovalPlan>;

  /** Applies a plan, and only that plan. */
  executeRemoval(
    plan: RemovalPlan,
    confirmation: RemovalConfirmation,
    signal?: AbortSignal,
  ): Promise<Result<RemovalOutcome, RemovalRefusal>>;

  reconcileTemporaryIngest(signal?: AbortSignal): Promise<ReconciliationReport>;
};

export function createLocalDataService(options: LocalDataServiceOptions): LocalDataService {
  const resolution = resolveRoots({
    platform: options.platform,
    home: options.home,
    environment: options.environment,
  });
  const { layout } = resolution;
  const registry: OwnershipRegistry = createOwnershipRegistry();

  const planInputs = (): PlanInputs => ({
    fileSystem: options.fileSystem,
    layout,
    registrations: registry.registrations(),
    unregistered: registry.unregistered(),
  });

  return {
    layout,
    resolutionIssues: resolution.issues,

    prepareRoots: (required, signal) => prepareRoots(options.fileSystem, layout, required, signal),

    inspectRoots: (signal) => inspectRoots(options.fileSystem, layout, signal),

    register: (registration) => registry.register(registration),
    registrations: () => registry.registrations(),
    unregistered: () => registry.unregistered(),

    reportRetention: (policy = UNCONSTRAINED_RETENTION, signal) =>
      reportRetention(
        {
          fileSystem: options.fileSystem,
          layout,
          registrations: registry.registrations(),
          unregistered: registry.unregistered(),
          policy,
        },
        signal,
      ),

    planReset: (selection, signal) => planReset(planInputs(), selection, signal),
    planUninstall: (signal) => planUninstall(planInputs(), signal),

    executeRemoval: (plan, confirmation, signal) =>
      executeRemoval(options.fileSystem, layout, plan, confirmation, signal),

    reconcileTemporaryIngest: (signal) =>
      reconcileTemporaryIngest(options.fileSystem, layout, signal),
  };
}
