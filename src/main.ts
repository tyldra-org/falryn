/**
 * Falryn's application bootstrap.
 *
 * It composes the control-flow lifecycle — clock, host signals, the root
 * cancellation scope, and the shutdown coordinator — and the local data
 * foundation: the resolved roots, the ownership registry, and the one SQLite
 * connection with its migrations applied.
 *
 * There is no product work to run yet, so the bootstrap opens storage and shuts
 * down immediately. Doing it here is the point: the composed lifecycle, the real
 * process-signal adapter, the real filesystem adapter, and the real `bun:sqlite`
 * adapter are all exercised by the compiled executable rather than only in
 * source mode, so a migration that does not survive `bun build --compile` fails
 * a check instead of a user's first run.
 *
 * Product composition will be added through focused, issue-backed changes.
 */

import { createRuntimeLifecycle, fromSqliteStoreError, fromUnknown } from "./application/index.ts";
import {
  createLocalDataService,
  createSqliteShutdownParticipant,
  FALLBACK_HOME,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  SQLITE_STATE_OWNERSHIP,
  sqliteDatabasePath,
  usableRoots,
} from "./data/index.ts";
import {
  createSystemClock,
  DEFAULT_BUSY_TIMEOUT_MS,
  type EnvironmentPort,
  err,
  type FalrynError,
  type LocalDataPlatform,
  type LocalPath,
  ok,
  type Result,
  type ShutdownReport,
  type SqliteOpenReport,
} from "./domain/index.ts";
import {
  createHostEnvironment,
  createHostFileSystem,
  createProcessSignalPort,
  hostHome,
  hostPlatform,
  openBunSqlite,
} from "./integrations/index.ts";

export type BootstrapOptions = {
  /** Supplied by tests so a run never resolves the developer's real roots. */
  readonly environment?: EnvironmentPort;
  readonly platform?: LocalDataPlatform;
  readonly home?: LocalPath;
};

export type BootstrapReport = {
  readonly shutdown: ShutdownReport;
  /**
   * What opening storage produced.
   *
   * Reported separately from the shutdown report because they answer different
   * questions: storage that never opened is not a shutdown that went wrong, and
   * folding one into the other would hide whichever failed second.
   */
  readonly storage: Result<SqliteOpenReport, FalrynError>;
};

export async function main(options: BootstrapOptions = {}): Promise<BootstrapReport> {
  const clock = createSystemClock();
  const lifecycle = createRuntimeLifecycle({
    clock,
    signals: createProcessSignalPort(),
  });

  const environment = options.environment ?? createHostEnvironment();
  const localData = createLocalDataService({
    fileSystem: createHostFileSystem(),
    environment,
    platform: options.platform ?? hostPlatform(),
    home: options.home ?? hostHome() ?? FALLBACK_HOME,
  });
  // Registered here rather than inside the store, so the class exists in the
  // registry even on a run where the database could not be opened — a reset
  // plan has to be able to name state it failed to reach.
  localData.register(SQLITE_STATE_OWNERSHIP);

  const storage = await openStorage(localData, clock);

  try {
    return { shutdown: await lifecycle.requestShutdown(), storage };
  } finally {
    // Releases the host signal subscription. Without this the process stays
    // alive holding a listener nothing is waiting on.
    lifecycle.dispose();
  }

  async function openStorage(
    service: ReturnType<typeof createLocalDataService>,
    systemClock: ReturnType<typeof createSystemClock>,
  ): Promise<Result<SqliteOpenReport, FalrynError>> {
    const statuses = await service.prepareRoots(["state"]);
    if (!usableRoots(statuses).includes("state")) {
      const status = statuses.find((candidate) => candidate.root === "state");
      return err(
        fromUnknown(new Error(`the state root is unusable: ${status?.code ?? "unresolved"}`), {
          operation: "prepare state root",
        }),
      );
    }

    const stateRoot = rootChild(service.layout, "state");
    const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    if (stateRoot === null || databasePath === null) {
      return err(
        fromUnknown(new Error("the database path could not be resolved"), {
          operation: "resolve database path",
        }),
      );
    }

    const opened = await openSqliteStore({
      open: openBunSqlite,
      clock: systemClock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    if (!opened.ok) {
      return err(fromSqliteStoreError(opened.error, { operation: "open local database" }));
    }

    // The first `close-storage` participant. A statement still running when the
    // phase deadline passes leaves it unfinished, which makes the shutdown
    // `uncertain` — the coordinator's existing contract, not a new one.
    lifecycle.shutdown.register(createSqliteShutdownParticipant(opened.value));
    return ok(opened.value.report);
  }
}

if (import.meta.main) {
  const report = await main();
  process.exitCode = report.shutdown.outcome.kind === "completed" && report.storage.ok ? 0 : 1;
}
