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
  ARTIFACTS_OWNERSHIP,
  beginRun,
  createArtifactRepository,
  createArtifactShutdownParticipant,
  createArtifactStore,
  createEventStoreShutdownParticipant,
  createLocalDataService,
  createProjectionRunner,
  createProjectionShutdownParticipant,
  createRunShutdownParticipant,
  createSqliteEventStore,
  createSqliteShutdownParticipant,
  FALLBACK_HOME,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeCrashSignals,
  recoverInterruptedWork,
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
  type RecoveryReport,
  type Result,
  runId,
  type ShutdownReport,
  type SqliteOpenReport,
} from "./domain/index.ts";
import {
  createHostBlobStore,
  createHostEnvironment,
  createHostFileSystem,
  createProcessSignalPort,
  createSha256Hasher,
  hostHome,
  hostPlatform,
  openBunSqlite,
} from "./integrations/index.ts";

export type BootstrapOptions = {
  /** Supplied by tests so a run never resolves the developer's real roots. */
  readonly environment?: EnvironmentPort;
  readonly platform?: LocalDataPlatform;
  readonly home?: LocalPath;
  /** Supplied by tests so a run's identity is stable across a comparison. */
  readonly runId?: string;
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
  /**
   * What startup recovery established about earlier runs.
   *
   * `null` when storage never opened or the artifact roots could not be
   * resolved, so "recovery found nothing" and "recovery did not run" stay
   * distinguishable.
   */
  readonly recovery: RecoveryReport | null;
};

export async function main(options: BootstrapOptions = {}): Promise<BootstrapReport> {
  const clock = createSystemClock();
  const lifecycle = createRuntimeLifecycle({
    clock,
    signals: createProcessSignalPort(),
  });

  const environment = options.environment ?? createHostEnvironment();
  const fileSystem = createHostFileSystem();
  const localData = createLocalDataService({
    fileSystem,
    environment,
    platform: options.platform ?? hostPlatform(),
    home: options.home ?? hostHome() ?? FALLBACK_HOME,
  });
  // Registered here rather than inside the store, so the class exists in the
  // registry even on a run where the database could not be opened — a reset
  // plan has to be able to name state it failed to reach.
  localData.register(SQLITE_STATE_OWNERSHIP);
  // Registered for the same reason, and before any byte is written: a reset
  // plan has to be able to name artifacts on a run where none was ingested.
  localData.register(ARTIFACTS_OWNERSHIP);

  let recovery: RecoveryReport | null = null;
  const storage = await openStorage(localData, clock);

  try {
    return { shutdown: await lifecycle.requestShutdown(), storage, recovery };
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

    // Probed before the database is opened, because opening it creates both
    // files. A probe taken afterwards would report every run as crashed.
    const crashSignals = await probeCrashSignals(fileSystem, stateRoot);

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

    // This run's row, written before anything else reads or writes. Without it
    // a later pass would read this process's in-flight bytes as unattributable,
    // so a failure here is a startup failure rather than a skipped step.
    const run = beginRun({
      store: opened.value,
      clock: systemClock,
      runId: runId.from(options.runId ?? crypto.randomUUID()),
    });
    if (!run.ok) {
      return err(
        fromUnknown(new Error(`the run could not be recorded: ${run.error.code}`), {
          operation: "record run",
        }),
      );
    }

    const artifactsRoot = rootChild(service.layout, "artifacts");
    const temporaryRoot = rootChild(service.layout, "temporaryIngest");
    const blobs =
      artifactsRoot === null || temporaryRoot === null
        ? null
        : createHostBlobStore({ artifactsRoot, temporaryRoot });
    const hasher = createSha256Hasher();

    // Runs after migrations and before any producer, which is what makes its
    // central claim safe: anything without a completion time belongs to a run
    // that is gone, because this run has not created anything yet.
    if (blobs !== null) {
      recovery = await recoverInterruptedWork({
        store: opened.value,
        blobs,
        hasher,
        clock: systemClock,
        runId: run.value.record.runId,
        crashSignals,
      });
    }

    // The durable event store and its projection runner, composed over the one
    // open database. There is no producer yet — the agent loop that starts a
    // session and records a turn is a later change — so this build exercises
    // the schema rather than writing a synthetic session into a user's
    // database.
    const eventStore = createSqliteEventStore(opened.value);
    const projections = createProjectionRunner({
      store: opened.value,
      events: eventStore,
      clock: systemClock,
    });

    // Registered in phase order, and the order is the point: `finalize-artifacts`
    // settles or discards in-flight bytes, `persist-outcomes` then stops
    // accepting appends and stamps this run's clean end, `checkpoint-projections`
    // writes each cursor at the last sequence it applied, and only then does
    // `close-storage` run its truncating checkpoint — against a database with
    // nothing still writing to it.
    if (blobs !== null) {
      // The artifact store, composed over the same database and the host blob
      // adapter. There is no producer yet either, so this build exercises the
      // schema, the ports, and the `finalize-artifacts` phase rather than
      // writing bytes into a user's roots. Neither root is prepared here: a run
      // that writes no artifact has no reason to create an artifacts directory,
      // and the adapter creates what it needs when it needs it.
      lifecycle.shutdown.register(
        createArtifactShutdownParticipant(
          createArtifactStore({
            repository: createArtifactRepository(opened.value),
            blobs,
            hasher,
            clock: systemClock,
          }),
        ),
      );
    }
    lifecycle.shutdown.register(createEventStoreShutdownParticipant(eventStore));
    // Registered in `persist-outcomes` rather than `close-storage`, because
    // participants inside one phase run concurrently and the run's end is a
    // durable write that has to land before the connection is closing.
    lifecycle.shutdown.register(createRunShutdownParticipant(run.value));
    lifecycle.shutdown.register(createProjectionShutdownParticipant(projections));
    // A statement still running when the phase deadline passes leaves this
    // participant unfinished, which makes the shutdown `uncertain` — the
    // coordinator's existing contract, not a new one.
    lifecycle.shutdown.register(createSqliteShutdownParticipant(opened.value));
    return ok(opened.value.report);
  }
}

if (import.meta.main) {
  const report = await main();
  process.exitCode = report.shutdown.outcome.kind === "completed" && report.storage.ok ? 0 : 1;
}
