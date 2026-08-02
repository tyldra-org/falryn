/**
 * Startup recovery of interrupted writes.
 *
 * A run that was killed, crashed, or lost power leaves durable state behind.
 * This pass runs once, after migrations and before any producer, and
 * establishes what that state is. It reads and decides; it never repairs by
 * guessing.
 *
 * Five rules the implementation carries rather than documents:
 *
 * - **An unended run is presumed live, and its bytes are never touched.** With
 *   no liveness probe in v0.1, this is the only rule that cannot destroy a
 *   concurrent Falryn's in-flight work. The alternative — calling an unended
 *   run abandoned once it is old enough — deletes the temporary bytes of every
 *   session that outlives the window.
 * - **Recovery never invents a completion.** An interrupted record becomes
 *   `uncertain` with `uncertain` effect. It never becomes `failed`: failure is
 *   an observation, and this is the absence of one.
 * - **A digest decides an artifact's fate, not a stat.** Bytes that are present
 *   and verify make a record `available`; present and not verifying makes it
 *   `quarantined` and moves the bytes aside rather than deleting them; absent
 *   makes it `missing` — the state #14 declared and deliberately left
 *   uninferred.
 * - **Mark, recheck, then act.** Anything removed is re-read immediately before
 *   the removal, because a record can commit between the decision and the
 *   deletion.
 * - **A bound reached is reported, never rounded off.** A pass that stopped
 *   claims nothing about what it did not reach.
 */

import {
  type ArtifactId,
  type ArtifactRecoveryOutcome,
  artifactId,
  type BlobLocation,
  type BlobStorePort,
  type ClockPort,
  type ContentDigest,
  type ContentHasherPort,
  type CrashSignals,
  contentDigest,
  DEFAULT_RECOVERY_WINDOW_MS,
  type EffectCertainty,
  err,
  type FileSystemPort,
  type Instant,
  invocationId,
  joinPath,
  type LocalPath,
  MAX_RECOVERED_ARTIFACTS,
  MAX_RECOVERED_BLOBS,
  MAX_RECOVERED_RECORDS,
  MAX_RECOVERY_VERIFIED_BYTES,
  type MeasurementCompleteness,
  modelAttemptId,
  NO_CRASH_SIGNALS,
  ok,
  parseRunRecord,
  type RecordCompletion,
  type RecoveryCount,
  type RecoveryError,
  type RecoveryReport,
  type Result,
  type RunId,
  type RunRecord,
  runId,
  type ShutdownParticipant,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStorePort,
  type SqliteValue,
  type TemporaryBlobOutcome,
  type Timestamp,
  timestampFromEpochMilliseconds,
  timestampToEpochMilliseconds,
  turnId,
} from "../domain/index.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";
import { verifyStoredBytes } from "./artifact-store.ts";
import { applyCompletion } from "./repositories.ts";
import { RUNS_TABLE } from "./run-schema.ts";
import { INVOCATIONS_TABLE, MODEL_ATTEMPTS_TABLE, SESSIONS_TABLE, TURNS_TABLE } from "./schema.ts";
import { SQLITE_DATABASE_FILE } from "./sqlite-store.ts";

/** The `persist-outcomes` participant that stamps this run's clean end. */
export const RUN_PARTICIPANT_NAME = "run-record";

const INSERT_RUN = `INSERT INTO ${RUNS_TABLE} (run_id, started_at, ended_at, schema_version)
  VALUES ($runId, $startedAt, NULL, $schemaVersion)`;

const SELECT_RUN = `SELECT run_id AS runId, started_at AS startedAt, ended_at AS endedAt,
  schema_version AS schemaVersion FROM ${RUNS_TABLE} WHERE run_id = $runId`;

const SELECT_RUNS = `SELECT run_id AS runId, started_at AS startedAt, ended_at AS endedAt,
  schema_version AS schemaVersion FROM ${RUNS_TABLE}`;

const END_RUN = `UPDATE ${RUNS_TABLE} SET ended_at = $endedAt
  WHERE run_id = $runId AND ended_at IS NULL`;

const SELECT_RESERVED = `SELECT artifact_id AS artifactId, digest AS digest,
  byte_length AS byteLength, run_id AS runId
  FROM ${ARTIFACTS_TABLE} WHERE availability = 'reserved'
  ORDER BY created_at, artifact_id LIMIT $limit`;

const SELECT_ARTIFACT_RUN = `SELECT run_id AS runId, availability AS availability
  FROM ${ARTIFACTS_TABLE} WHERE artifact_id = $artifactId`;

const MOVE_ARTIFACT = `UPDATE ${ARTIFACTS_TABLE}
  SET availability = $availability, finalized_at = $finalizedAt
  WHERE artifact_id = $artifactId AND availability = 'reserved'`;

/** How a non-terminal record of each entity is found and completed. */
const NON_TERMINAL: readonly {
  readonly entity: RecordCompletion["entity"] | "session";
  readonly select: string;
}[] = [
  {
    entity: "invocation",
    select: `SELECT invocation_id AS id FROM ${INVOCATIONS_TABLE}
      WHERE completed_at IS NULL LIMIT $limit`,
  },
  {
    entity: "model-attempt",
    select: `SELECT model_attempt_id AS id FROM ${MODEL_ATTEMPTS_TABLE}
      WHERE completed_at IS NULL LIMIT $limit`,
  },
  {
    entity: "turn",
    select: `SELECT turn_id AS id FROM ${TURNS_TABLE}
      WHERE completed_at IS NULL LIMIT $limit`,
  },
  {
    entity: "session",
    select: `SELECT session_id AS id FROM ${SESSIONS_TABLE}
      WHERE closed_at IS NULL LIMIT $limit`,
  },
];

/**
 * A session is completed here rather than through {@link applyCompletion}.
 *
 * The shared statement covers the three entities whose completion a projection
 * also derives; a session's close is not one of those, and its column is named
 * differently. Spelling it once here beats widening a contract that has one
 * other caller.
 */
const CLOSE_SESSION = `UPDATE ${SESSIONS_TABLE}
  SET closed_at = $closedAt, outcome_kind = 'uncertain', outcome_effect = 'uncertain'
  WHERE session_id = $id AND closed_at IS NULL`;

function storageError(error: SqliteStoreError): RecoveryError {
  return { kind: "recovery", code: "storage", error };
}

function textOf(value: SqliteValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function integerOf(value: SqliteValue | undefined): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : null;
}

/**
 * Probes for the files a clean close removes.
 *
 * Runs *before* the database is opened, because opening it creates both. A
 * caller that probed afterwards would report every run as crashed.
 */
export async function probeCrashSignals(
  fileSystem: FileSystemPort,
  stateRoot: LocalPath,
  signal?: AbortSignal,
): Promise<CrashSignals> {
  const present = async (suffix: string): Promise<boolean> => {
    const path = joinPath(stateRoot, `${SQLITE_DATABASE_FILE}${suffix}`);
    if (!path.ok) {
      return false;
    }
    const stat = await fileSystem.stat(path.value, signal);
    // A probe that could not look reports nothing rather than a crash: an
    // unreadable directory is not evidence that a run died.
    return stat.ok && stat.value !== null;
  };
  return {
    writeAheadLogPresent: await present("-wal"),
    sharedMemoryPresent: await present("-shm"),
  };
}

export type RunSession = {
  readonly record: RunRecord;
  /**
   * Stamps this run's clean end. Idempotent.
   *
   * "Clean" means the run reached its shutdown sequence, which is the fact
   * recovery needs. A close that then fails leaves its own signal beside the
   * database; conflating the two would make every failed close look like a
   * kill.
   */
  end(signal?: AbortSignal): Result<null, RecoveryError>;
};

export type BeginRunOptions = {
  readonly store: SqliteStorePort;
  readonly clock: ClockPort;
  readonly runId: RunId;
};

/**
 * Writes this run's row.
 *
 * A failure here is a startup failure rather than a skipped step: without the
 * row, every later pass would read this process's in-flight bytes as
 * unattributable, and recovery that did not run must not look like recovery
 * that found nothing.
 */
export function beginRun(options: BeginRunOptions): Result<RunSession, RecoveryError> {
  const { store, clock } = options;
  const startedAt = timestampFromEpochMilliseconds(clock.now());
  const record: RunRecord = {
    runId: options.runId,
    startedAt,
    endedAt: null,
    schemaVersion: store.report.schemaVersion,
  };

  const written = store.write((statements) => {
    if (statements.all(SELECT_RUN, { runId: options.runId }).length > 0) {
      return { kind: "recovery", code: "already-exists", runId: options.runId } as RecoveryError;
    }
    statements.run(INSERT_RUN, {
      runId: record.runId,
      startedAt: record.startedAt,
      schemaVersion: record.schemaVersion,
    });
    return null;
  });
  if (!written.ok) {
    return err(storageError(written.error));
  }
  if (written.value.value !== null) {
    return err(written.value.value);
  }

  return ok({
    record,
    end(signal?: AbortSignal): Result<null, RecoveryError> {
      const endedAt = timestampFromEpochMilliseconds(clock.now());
      const stamped = store.write(
        (statements) => statements.run(END_RUN, { runId: options.runId, endedAt }),
        signal,
      );
      return stamped.ok ? ok(null) : err(storageError(stamped.error));
    },
  });
}

/**
 * The `persist-outcomes` participant.
 *
 * This phase rather than `close-storage`, because participants inside one phase
 * run concurrently and the run's end is a durable write that has to land before
 * the connection is closing. It runs after `finalize-artifacts`, so a run is
 * only recorded as ended once its in-flight bytes have settled.
 */
export function createRunShutdownParticipant(run: RunSession): ShutdownParticipant {
  return {
    name: RUN_PARTICIPANT_NAME,
    phase: "persist-outcomes",
    async run(context): Promise<void> {
      const ended = run.end(context.signal);
      if (!ended.ok) {
        throw new Error(`the run's end could not be recorded: ${ended.error.code}`);
      }
    },
  };
}

export type RecoveryOptions = {
  readonly store: SqliteStorePort;
  readonly blobs: BlobStorePort;
  readonly hasher: ContentHasherPort;
  readonly clock: ClockPort;
  /** This run, which is never treated as an earlier one. */
  readonly runId: RunId;
  readonly crashSignals?: CrashSignals;
  readonly recoveryWindowMs?: number;
};

/** One pass's mutable tally, so every branch reports through one place. */
type Tally = {
  markedUncertain: number;
  artifactsExamined: number;
  temporaryBlobsExamined: number;
  failed: number;
  verifiedBytes: number;
  completeness: MeasurementCompleteness;
  readonly artifacts: Map<ArtifactRecoveryOutcome, number>;
  readonly blobs: Map<TemporaryBlobOutcome, number>;
};

export async function recoverInterruptedWork(
  options: RecoveryOptions,
  signal?: AbortSignal,
): Promise<RecoveryReport> {
  const tally: Tally = {
    markedUncertain: 0,
    artifactsExamined: 0,
    temporaryBlobsExamined: 0,
    failed: 0,
    verifiedBytes: 0,
    completeness: "complete",
    artifacts: new Map(),
    blobs: new Map(),
  };

  const runs = readRuns(options.store);
  if (!runs.ok) {
    tally.completeness = "partial";
  }
  const known = runs.ok ? runs.value : [];

  completeInterruptedRecords(options, tally, signal);
  await resolveReservedArtifacts(options, known, tally, signal);
  await collectTemporaryBlobs(options, known, tally, signal);

  return {
    runId: options.runId,
    crashSignals: options.crashSignals ?? NO_CRASH_SIGNALS,
    markedUncertain: tally.markedUncertain,
    artifactsExamined: tally.artifactsExamined,
    artifacts: counts(tally.artifacts),
    temporaryBlobsExamined: tally.temporaryBlobsExamined,
    temporaryBlobs: counts(tally.blobs),
    failed: tally.failed,
    completeness: tally.completeness,
    effect: effectOfPass(tally),
  };
}

function counts<Outcome extends string>(
  tallied: Map<Outcome, number>,
): readonly RecoveryCount<Outcome>[] {
  return [...tallied].map(([outcome, count]) => ({ outcome, count }));
}

/**
 * What the pass changed, in the runtime's own certainty vocabulary.
 *
 * `none` when nothing was touched, `completed` when everything it attempted
 * landed, and `partial` the moment anything failed — a pass that repaired nine
 * records and could not repair the tenth has not completed.
 */
function effectOfPass(tally: Tally): EffectCertainty {
  const changed =
    tally.markedUncertain +
    (tally.artifacts.get("available") ?? 0) +
    (tally.artifacts.get("quarantined") ?? 0) +
    (tally.artifacts.get("missing") ?? 0) +
    (tally.blobs.get("discarded") ?? 0);
  if (tally.failed > 0) {
    return changed === 0 ? "none" : "partial";
  }
  return changed === 0 ? "none" : "completed";
}

function record<Outcome extends string>(
  tallied: Map<Outcome, number>,
  outcome: Outcome,
  by = 1,
): void {
  if (by > 0) {
    tallied.set(outcome, (tallied.get(outcome) ?? 0) + by);
  }
}

function readRuns(store: SqliteStorePort): Result<readonly RunRecord[], RecoveryError> {
  const rows = store.read(SELECT_RUNS);
  if (!rows.ok) {
    return err(storageError(rows.error));
  }
  const records: RunRecord[] = [];
  for (const row of rows.value) {
    const parsed = parseRunRecord(row);
    if (!parsed.ok) {
      return err({ kind: "recovery", code: "malformed-row", issues: parsed.error });
    }
    records.push(parsed.value);
  }
  return ok(records);
}

/**
 * Completes every record an earlier run left running.
 *
 * Safe by ordering rather than by attribution: this runs before this run has
 * created a session, a turn, an attempt, or an invocation, so anything without
 * a completion time necessarily belongs to a run that is gone. Each becomes
 * `uncertain` carrying `uncertain` effect — whether the external effect landed
 * is exactly what cannot be established from the outside — and nothing becomes
 * `failed` and nothing is deleted.
 */
function completeInterruptedRecords(
  options: RecoveryOptions,
  tally: Tally,
  signal: AbortSignal | undefined,
): void {
  const completedAt = timestampFromEpochMilliseconds(options.clock.now());

  for (const target of NON_TERMINAL) {
    if (signal?.aborted === true) {
      tally.completeness = "partial";
      return;
    }
    const rows = options.store.read(target.select, { limit: MAX_RECOVERED_RECORDS });
    if (!rows.ok) {
      tally.completeness = "partial";
      tally.failed += 1;
      continue;
    }
    if (rows.value.length >= MAX_RECOVERED_RECORDS) {
      tally.completeness = "partial";
    }

    const identities = rows.value.flatMap((row) => {
      const id = textOf(row.id);
      return id === null ? [] : [id];
    });
    if (identities.length === 0) {
      continue;
    }

    const written = options.store.write(
      (statements) => completeAll(statements, target.entity, identities, completedAt),
      signal,
    );
    if (written.ok) {
      tally.markedUncertain += written.value.value;
    } else {
      tally.completeness = "partial";
      tally.failed += 1;
    }
  }
}

/** Applies one entity's completions inside the caller's transaction. */
function completeAll(
  statements: SqliteStatements,
  entity: (typeof NON_TERMINAL)[number]["entity"],
  identities: readonly string[],
  completedAt: Timestamp,
): number {
  let changed = 0;
  for (const id of identities) {
    if (entity === "session") {
      changed += statements.run(CLOSE_SESSION, { id, closedAt: completedAt }).changes;
      continue;
    }
    // The shared completion statement, so recovery and the projection that
    // derives the same columns never drift into two spellings of "completed".
    const completion = completionFor(entity, id, completedAt);
    if (completion !== null && applyCompletion(statements, completion)) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Builds one completion, or `null` when the stored identity is not one.
 *
 * A row this build cannot read an identity out of is skipped rather than
 * completed: writing an outcome onto a row whose identity is malformed would
 * be repairing something nobody can name.
 */
function completionFor(
  entity: RecordCompletion["entity"],
  id: string,
  completedAt: Timestamp,
): RecordCompletion | null {
  const outcome = { kind: "uncertain", effect: "uncertain" } as const;
  switch (entity) {
    case "turn": {
      const parsed = turnId.parse(id);
      return parsed.ok ? { entity, turnId: parsed.value, completedAt, outcome } : null;
    }
    case "model-attempt": {
      const parsed = modelAttemptId.parse(id);
      return parsed.ok ? { entity, modelAttemptId: parsed.value, completedAt, outcome } : null;
    }
    case "invocation": {
      const parsed = invocationId.parse(id);
      return parsed.ok ? { entity, invocationId: parsed.value, completedAt, outcome } : null;
    }
  }
}

/** One reserved artifact, as the pass needs to see it. */
type ReservedArtifact = {
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly runId: RunId | null;
};

/**
 * Resolves every artifact an earlier run left reserved.
 *
 * A reserved row means the metadata committed and the bytes had not been
 * verified in place. Which of the three ways that ended is decided from the
 * bytes themselves, never from the row.
 */
async function resolveReservedArtifacts(
  options: RecoveryOptions,
  runs: readonly RunRecord[],
  tally: Tally,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rows = options.store.read(SELECT_RESERVED, { limit: MAX_RECOVERED_ARTIFACTS });
  if (!rows.ok) {
    tally.completeness = "partial";
    tally.failed += 1;
    return;
  }
  if (rows.value.length >= MAX_RECOVERED_ARTIFACTS) {
    tally.completeness = "partial";
  }

  for (const row of rows.value) {
    if (signal?.aborted === true) {
      tally.completeness = "partial";
      return;
    }
    const reserved = parseReserved(row);
    if (reserved === null) {
      tally.completeness = "partial";
      tally.failed += 1;
      continue;
    }
    tally.artifactsExamined += 1;

    if (mayStillBeWritten(reserved.runId, runs, options.runId)) {
      // Another process may be finishing this very ingest.
      record(tally.artifacts, "left-for-inspection");
      continue;
    }
    if (tally.verifiedBytes + reserved.byteLength > MAX_RECOVERY_VERIFIED_BYTES) {
      // Startup has to finish. What was not read is not concluded about.
      tally.completeness = "partial";
      record(tally.artifacts, "left-for-inspection");
      continue;
    }

    await resolveOne(options, reserved, tally, signal);
  }
}

async function resolveOne(
  options: RecoveryOptions,
  reserved: ReservedArtifact,
  tally: Tally,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { blobs, hasher } = options;
  const content: BlobLocation = { scope: "content", digest: reserved.digest };

  const present = await blobs.byteLength(content, signal);
  if (!present.ok) {
    tally.failed += 1;
    record(tally.artifacts, "left-for-inspection");
    return;
  }

  if (present.value === null) {
    // Nothing was ever moved into place, or it is gone. Either way the record
    // describes bytes that are not there, which is the one state #14 declared
    // and left for this pass to infer.
    await discardTemporary(options, reserved.artifactId, tally, signal);
    move(options, reserved.artifactId, "missing", tally);
    return;
  }

  tally.verifiedBytes += reserved.byteLength;
  const verified = await verifyStoredBytes(
    { blobs, hasher, digest: reserved.digest, byteLength: reserved.byteLength },
    signal,
  );
  if (!verified.ok) {
    tally.failed += 1;
    record(tally.artifacts, "left-for-inspection");
    return;
  }

  if (verified.value) {
    move(options, reserved.artifactId, "available", tally);
    return;
  }

  // Set aside, never deleted: bytes that failed to verify are the evidence of
  // whatever went wrong.
  const setAside = await blobs.finalize(
    content,
    { scope: "quarantine", digest: reserved.digest },
    signal,
  );
  if (!setAside.ok) {
    tally.failed += 1;
    record(tally.artifacts, "left-for-inspection");
    return;
  }
  move(options, reserved.artifactId, "quarantined", tally);
}

/** Moves one reserved row to its resolved state, counting what happened. */
function move(
  options: RecoveryOptions,
  id: ArtifactId,
  availability: Extract<ArtifactRecoveryOutcome, "available" | "quarantined" | "missing">,
  tally: Tally,
): void {
  const finalizedAt = timestampFromEpochMilliseconds(options.clock.now());
  const written = options.store.write(
    (statements) =>
      statements.run(MOVE_ARTIFACT, { artifactId: id, availability, finalizedAt }).changes,
  );
  if (!written.ok || written.value.value === 0) {
    tally.failed += 1;
    record(tally.artifacts, "left-for-inspection");
    return;
  }
  record(tally.artifacts, availability);
}

function parseReserved(row: SqliteRow): ReservedArtifact | null {
  const id = artifactId.parse(textOf(row.artifactId));
  const digest = contentDigest.parse(textOf(row.digest));
  const byteLength = integerOf(row.byteLength);
  if (!id.ok || !digest.ok || byteLength === null) {
    return null;
  }
  const owner = textOf(row.runId);
  const parsedOwner = owner === null ? null : runId.parse(owner);
  return {
    artifactId: id.value,
    digest: digest.value,
    byteLength,
    runId: parsedOwner === null || !parsedOwner.ok ? null : parsedOwner.value,
  };
}

/**
 * Whether anything may still be writing these bytes.
 *
 * True for an unended run other than this one, which is presumed live, and
 * true for *this* run as well: recovery runs before this process has created
 * anything, so a row it appears to own is a row it cannot have abandoned, and
 * resolving it would be repairing a state this pass does not understand.
 *
 * A null owner is never still being written: rows written before migration
 * `0003` predate every run, and a blob nothing attributes has no run to be
 * writing it.
 */
function mayStillBeWritten(
  owner: RunId | null,
  runs: readonly RunRecord[],
  thisRun: RunId,
): boolean {
  if (owner === null) {
    return false;
  }
  if (owner === thisRun) {
    return true;
  }
  const found = runs.find((candidate) => candidate.runId === owner);
  return found !== undefined && found.endedAt === null;
}

/**
 * Discards in-flight bytes an earlier run left behind.
 *
 * Three cases, and only the first two are ever removed:
 *
 * - **Attributed to a run that ended.** Nothing can still want it. Rechecked
 *   against the record immediately before the removal, because a record can
 *   commit between the decision and the deletion.
 * - **Unattributable, with no other run still open.** Nothing on this machine
 *   is past startup, so nothing can be writing it — and the recovery window
 *   covers the one remaining race, a process that has inserted its run row and
 *   has not yet allocated.
 * - **Attributed to a run that never ended.** Presumed live. Reported and left
 *   exactly as found, whatever its age.
 */
async function collectTemporaryBlobs(
  options: RecoveryOptions,
  runs: readonly RunRecord[],
  tally: Tally,
  signal: AbortSignal | undefined,
): Promise<void> {
  const listed = await options.blobs.list("temporary", MAX_RECOVERED_BLOBS, signal);
  if (!listed.ok) {
    tally.completeness = "partial";
    return;
  }
  if (listed.value.length >= MAX_RECOVERED_BLOBS) {
    tally.completeness = "partial";
  }

  const quiet = noOtherRunOpen(runs, options.runId) && windowElapsed(options, runs);

  for (const location of listed.value) {
    if (signal?.aborted === true) {
      tally.completeness = "partial";
      return;
    }
    if (location.scope !== "temporary") {
      continue;
    }
    tally.temporaryBlobsExamined += 1;

    const owner = ownerOfBlob(options.store, location.artifactId);
    if (owner === "unreadable") {
      tally.completeness = "partial";
      tally.failed += 1;
      record(tally.blobs, "left-for-inspection");
      continue;
    }
    if (owner !== "unattributed" && mayStillBeWritten(owner, runs, options.runId)) {
      record(tally.blobs, "left-for-inspection");
      continue;
    }
    if (owner === "unattributed" && !quiet) {
      record(tally.blobs, "left-for-inspection");
      continue;
    }

    const removed = await options.blobs.remove(location, signal);
    if (removed.ok) {
      record(tally.blobs, "discarded");
    } else {
      tally.failed += 1;
      record(tally.blobs, "failed");
    }
  }
}

/** The run that owns a blob, or why that could not be established. */
function ownerOfBlob(
  store: SqliteStorePort,
  id: ArtifactId,
): RunId | null | "unattributed" | "unreadable" {
  const rows = store.read(SELECT_ARTIFACT_RUN, { artifactId: id });
  if (!rows.ok) {
    return "unreadable";
  }
  const row = rows.value[0];
  if (row === undefined) {
    // Bytes were allocated and no record was ever committed for them.
    return "unattributed";
  }
  const owner = textOf(row.runId);
  if (owner === null) {
    return "unattributed";
  }
  const parsed = runId.parse(owner);
  return parsed.ok ? parsed.value : "unattributed";
}

function noOtherRunOpen(runs: readonly RunRecord[], thisRun: RunId): boolean {
  return !runs.some((run) => run.endedAt === null && run.runId !== thisRun);
}

/**
 * Whether every run this database knows about started long enough ago.
 *
 * The window exists for exactly one race: a second process that has written its
 * run row and has not yet allocated the bytes it is about to write. This run's
 * own row is included, because a simultaneous start is precisely that race.
 */
function windowElapsed(options: RecoveryOptions, runs: readonly RunRecord[]): boolean {
  const window = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
  const now: Instant = options.clock.now();
  return runs.every((run) => now - timestampToEpochMilliseconds(run.startedAt) >= window);
}

async function discardTemporary(
  options: RecoveryOptions,
  id: ArtifactId,
  tally: Tally,
  signal: AbortSignal | undefined,
): Promise<void> {
  const location: BlobLocation = { scope: "temporary", artifactId: id };
  const present = await options.blobs.byteLength(location, signal);
  if (!present.ok || present.value === null) {
    return;
  }
  // Unverified partials belonging to a run that is gone. They never reached
  // content, so nothing references them and nothing can complete them.
  const removed = await options.blobs.remove(location, signal);
  if (removed.ok) {
    tally.temporaryBlobsExamined += 1;
    record(tally.blobs, "discarded");
  } else {
    tally.failed += 1;
  }
}

/** Whether a recovery pass concluded anything about every artifact it saw. */
export function isCompleteRecovery(report: RecoveryReport): boolean {
  return report.completeness === "complete" && report.failed === 0;
}
