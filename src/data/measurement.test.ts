/**
 * The persistence resource measurement.
 *
 * Six quantities that were previously asserted rather than measured:
 * transaction latency, busy wait and refusal rate, migration time, database
 * size, artifact throughput, and range-read latency. This module measures them
 * against the real owners on the qualified platform and prints each result with
 * the five things a performance number has to carry to mean anything —
 * hardware/platform, dataset, cold/warm state, sample count, and variability.
 *
 * Five rules it carries rather than documents:
 *
 * - **It is gated and visibly absent when ungated.** `bun run measure` sets
 *   `FALRYN_MEASURE=1`; a default `bun run check` reports five skipped tests
 *   from this module — Bun records each test inside a false `describe.if` as
 *   skipped, and the last one exists only to name `bun run measure`, the same
 *   shape `src/main.compiled.test.ts` uses for an unbuilt executable. It joins
 *   neither `check` nor `ci`, because a measurement that gates a merge is a
 *   threshold, and thresholds are the benchmark harness this repository has no
 *   owner for yet.
 * - **It asserts no timing threshold.** A timing assertion on a developer
 *   machine is a flake. What it does assert is that the work it measured
 *   actually happened — the rows are there, the bytes read back, the schema
 *   reached the current version — so a run that measured nothing cannot report
 *   zero and look fast.
 * - **Nothing is a double.** The blob store is `createHostBlobStore` against a
 *   real temporary root, never `createInMemoryBlobStore`. An artifact
 *   throughput number taken against memory measures RAM and reports it as disk,
 *   which is a wrong number rather than a partial one.
 * - **Contention is real.** Busy wait is observed against a second process
 *   holding the write lock, not against an injected error. Falryn performs no
 *   application-level retry — `src/data/sqlite-store.ts` reports `busy` and
 *   returns — so what is measured is how long a contending writer blocks inside
 *   SQLite's own busy handler and how often one exhausts the configured timeout
 *   and is refused.
 * - **A quantity that cannot be measured is reported as unmeasured with its
 *   reason.** Never omitted, and never reported as zero: an absent number that
 *   looks like a fast number is the failure this whole module exists to
 *   prevent.
 *
 * It changes no production source and is not reachable from `src/main.ts`, so
 * it never enters the compiled executable.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  capabilityInvocationCompleted,
  capabilityInvocationStarted,
  invocationRecord,
  modelAttemptRecord,
  modelAttemptStarted,
  sessionRecord,
  turnRecord,
  turnStarted,
} from "../domain/fixtures.ts";
import {
  type ArtifactId,
  artifactId,
  type BlobStorePort,
  createManualClock,
  DEFAULT_BUSY_TIMEOUT_MS,
  eventId,
  type InvocationId,
  idempotencyKey,
  invocationId,
  type LocalPath,
  localPath,
  type ModelAttemptId,
  modelAttemptId,
  type RecordError,
  type RuntimeEvent,
  runId as runIdCodec,
  type SessionId,
  type SqliteStorePort,
  type StreamId,
  sequence,
  sessionId,
  streamId,
  type TurnId,
  turnId,
} from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher, openBunSqlite } from "../integrations/index.ts";
import {
  binarySize,
  distribution,
  formatDistribution,
  MEASURING,
  mebibytes,
  report,
  unmeasured,
} from "../measurement-fixtures.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";
import { createArtifactStore } from "./artifact-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { FIXTURE_INSTANT, removeTemporaryRoots, temporaryRoot } from "./fixtures.ts";
import { beginRun } from "./recovery.ts";
import { createRecordRepositories } from "./repositories.ts";
import {
  EVENTS_TABLE,
  INVOCATIONS_TABLE,
  MODEL_ATTEMPTS_TABLE,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./schema.ts";
import { PRODUCT_SCHEMA_VERSION, PRODUCTION_MIGRATIONS } from "./sqlite-migrations.ts";
import { openSqliteStore, sqliteDatabasePath } from "./sqlite-store.ts";

// ── The declared dataset ────────────────────────────────────────────────────
//
// Fixed, bounded, and reported alongside every result, because a number whose
// input is not stated cannot be compared to anything. Small enough to run in
// seconds: this measures shape, not scale.

const SESSIONS = 50;
const TURNS_PER_SESSION = 5;
const EVENTS_PER_TURN = 4;
const TURNS = SESSIONS * TURNS_PER_SESSION;
const EVENTS = TURNS * EVENTS_PER_TURN;

/** One artifact, well under the 64 MiB configured ceiling and the 4 GiB bound. */
const ARTIFACT_BYTES = 8 * 1_024 * 1_024;
const ARTIFACT_CHUNK_BYTES = 1_024 * 1_024;
const ARTIFACT_SAMPLES = 3;

/** Bounded reads, well under the 8 MiB `MAX_ARTIFACT_RANGE_BYTES` ceiling. */
const RANGE_BYTES = 64 * 1_024;
const RANGE_SAMPLES = 64;

/** Fresh databases, each migrated cold. */
const MIGRATION_SAMPLES = 5;

/** Contending attempts per scenario. Fixed, so the measurement terminates. */
const CONTENTION_SAMPLES = 5;

/** How long the second process holds the write lock in each scenario. */
const SHORT_HOLD_MS = 300;
const LONG_HOLD_MS = 2_000;

/** The timeout the refusal scenario runs under, above `MIN_BUSY_TIMEOUT_MS`. */
const SHORT_BUSY_TIMEOUT_MS = 300;

const MEASUREMENT_TIMEOUT_MS = 300_000;

afterAll(removeTemporaryRoots);

// ── Opening ─────────────────────────────────────────────────────────────────

/**
 * The production store over a temporary root, at a chosen busy timeout.
 *
 * `openProductStoreOrThrow` in `fixtures.ts` is the near-equivalent and cannot
 * be used for the contention scenarios, which have to state and vary the
 * timeout they are observing.
 */
async function openStore(
  root: LocalPath,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): Promise<SqliteStorePort> {
  const path = sqliteDatabasePath(root);
  if (path === null) {
    throw new Error("the temporary root did not produce a database path");
  }
  const opened = await openSqliteStore({
    open: openBunSqlite,
    clock: createManualClock(FIXTURE_INSTANT),
    databasePath: path,
    backupDirectory: root,
    migrations: PRODUCTION_MIGRATIONS,
    busyTimeoutMs,
  });
  if (!opened.ok) {
    throw new Error(`expected the store to open: ${opened.error.code}`);
  }
  return opened.value;
}

function countIn(store: SqliteStorePort, table: string): number {
  const rows = store.read(`SELECT COUNT(*) AS total FROM ${table}`);
  if (!rows.ok) {
    throw new Error(`expected to count ${table}: ${rows.error.code}`);
  }
  const total = rows.value[0]?.total;
  return typeof total === "bigint" ? Number(total) : typeof total === "number" ? total : -1;
}

// ── The dataset ─────────────────────────────────────────────────────────────

function streamFor(index: number): StreamId {
  return streamId.from(`session:measure-${index}`);
}

/** Places one fixture event on this session's stream at this position. */
function atPosition<Event extends RuntimeEvent>(
  event: Event,
  stream: StreamId,
  suffix: string,
  position: number,
): Event {
  return {
    ...event,
    eventId: eventId.from(`${event.eventId}-${suffix}`),
    streamId: stream,
    sequence: sequence.from(position),
    idempotencyKey: idempotencyKey.from(`${event.idempotencyKey}-${suffix}`),
  };
}

/** The four events one turn carries, already in stream order. */
function eventsForTurn(stream: StreamId, suffix: string, firstPosition: number): RuntimeEvent[] {
  return [
    atPosition(turnStarted(), stream, suffix, firstPosition),
    atPosition(modelAttemptStarted(), stream, suffix, firstPosition + 1),
    atPosition(capabilityInvocationStarted(), stream, suffix, firstPosition + 2),
    atPosition(capabilityInvocationCompleted(), stream, suffix, firstPosition + 3),
  ];
}

function sessionIdFor(index: number): SessionId {
  return sessionId.from(`measure-session-${index}`);
}

function turnIdFor(session: number, turn: number): TurnId {
  return turnId.from(`measure-turn-${session}-${turn}`);
}

function attemptIdFor(session: number, turn: number): ModelAttemptId {
  return modelAttemptId.from(`measure-attempt-${session}-${turn}`);
}

function invocationIdFor(session: number, turn: number): InvocationId {
  return invocationId.from(`measure-invocation-${session}-${turn}`);
}

// ── Contention ──────────────────────────────────────────────────────────────

/**
 * The store's own classification of a refused write.
 *
 * A repository reports `storage` and carries the store's error inside it, and
 * `storage` is not the fact worth recording — `busy` is.
 */
function driverCodeOf(error: RecordError): string {
  return error.code === "storage" ? error.error.code : error.code;
}

/**
 * The second process, written against the adapter rather than the driver.
 *
 * `src/sqlite-boundaries.test.ts` asserts that `bun:sqlite` is imported and
 * `new Database` constructed in exactly one module in the whole tree, tests
 * included. Those two controls are unconditional on purpose, so the holder goes
 * through `openBunSqlite` — which is also the more honest staging: the writer
 * this one contends with is a real Falryn connection, opened the way Falryn
 * opens one.
 */
function holderScript(): string {
  const adapterUrl = new URL("../integrations/index.ts", import.meta.url).href;
  return [
    `import { openBunSqlite } from ${JSON.stringify(adapterUrl)};`,
    "const opened = openBunSqlite({ path: process.env.MEASURE_DB, create: false });",
    // Concatenated rather than interpolated: a `${}` inside this string is
    // source text for the child, and writing it that way makes the linter read
    // it as a template literal that lost its backticks.
    'if (!opened.ok) { throw new Error("could not open: " + opened.error.code); }',
    "const connection = opened.value;",
    // Held open across the sleep, which a `transaction` call could not do: it
    // commits when its callback returns.
    'connection.run("BEGIN IMMEDIATE");',
    'process.stdout.write("held\\n");',
    "await Bun.sleep(Number(process.env.MEASURE_HOLD_MS));",
    'connection.run("COMMIT");',
    "await connection.close();",
  ].join("\n");
}

type LockHolder = {
  /** Resolves once the second process has committed and exited. */
  readonly released: Promise<void>;
};

/**
 * A second process holding the write lock for a bounded time.
 *
 * A second *connection* in this process could not be used: `bun:sqlite` is
 * synchronous, so a contending write here blocks the only thread and no timer
 * could ever release the lock. The hold is bounded by its own argument, so the
 * scenario terminates whatever SQLite does.
 */
async function holdWriteLock(databasePath: string, holdMs: number): Promise<LockHolder> {
  const child = Bun.spawn(["bun", "-e", holderScript()], {
    env: {
      PATH: process.env.PATH ?? "",
      MEASURE_DB: databasePath,
      MEASURE_HOLD_MS: String(holdMs),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("held")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = await new Response(child.stderr).text();
      unmeasured(
        "busy wait and refusal rate",
        `the second process exited before taking the write lock: ${stderr.trim() || "no output"}`,
      );
    }
    output += decoder.decode(chunk.value);
  }

  return {
    released: child.exited.then((code) => {
      if (code !== 0) {
        throw new Error(`the lock holder exited with ${code}`);
      }
    }),
  };
}

// ── Artifact content ────────────────────────────────────────────────────────

/** Distinct bytes per sample, so no two ingests share a digest. */
function artifactBytes(sample: number): Uint8Array {
  const bytes = new Uint8Array(ARTIFACT_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index + sample) % 256;
  }
  return bytes;
}

async function* inChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += ARTIFACT_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(bytes.length, offset + ARTIFACT_CHUNK_BYTES));
  }
}

function blobStoreIn(root: LocalPath): BlobStorePort {
  return createHostBlobStore({
    artifactsRoot: localPath(join(root, "artifacts")),
    temporaryRoot: localPath(join(root, "ingest")),
  });
}

// ── The measurements ────────────────────────────────────────────────────────

describe.if(MEASURING)("persistence resource behavior", () => {
  test(
    "measures migration time on a fresh database",
    async () => {
      const samples: number[] = [];
      for (let sample = 0; sample < MIGRATION_SAMPLES; sample += 1) {
        const root = await temporaryRoot("falryn-measure-migration-");
        const started = Bun.nanoseconds();
        const store = await openStore(root);
        samples.push(Bun.nanoseconds() - started);

        // The work the number describes actually happened.
        expect(store.report.created).toBe(true);
        expect(store.report.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);
        expect(store.report.appliedThisRun).toEqual(
          PRODUCTION_MIGRATIONS.map((migration) => migration.version),
        );
        await store.close();
      }

      report({
        quantity: "migration time",
        against: "`openSqliteStore` bringing a fresh database to the current schema version",
        dataset: `an empty database, ${PRODUCTION_MIGRATIONS.length} migrations to schema version ${PRODUCT_SCHEMA_VERSION}`,
        state: "cold",
        result: formatDistribution(distribution(samples)),
        notes: [
          "each sample is a distinct fresh temporary root, so none is warmed by the one before it",
          "includes connection open, the pragma set, the integrity check, and every migration transaction",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures transaction latency and database size over the declared dataset",
    async () => {
      const root = await temporaryRoot("falryn-measure-dataset-");
      const store = await openStore(root);
      const repositories = createRecordRepositories(store);
      const events = createSqliteEventStore(store);

      // The warm-up, discarded: the session inserts run every code path the
      // timed turn inserts use, so the first timed sample measures the store
      // rather than a JIT runtime meeting this statement for the first time.
      for (let session = 0; session < SESSIONS; session += 1) {
        const written = repositories.sessions.insert(
          sessionRecord({
            sessionId: sessionIdFor(session),
            streamId: streamFor(session),
            title: `measurement session ${session}`,
          }),
        );
        expect(written.ok).toBe(true);
      }

      const transactionSamples: number[] = [];
      for (let session = 0; session < SESSIONS; session += 1) {
        for (let turn = 0; turn < TURNS_PER_SESSION; turn += 1) {
          const record = turnRecord({
            turnId: turnIdFor(session, turn),
            sessionId: sessionIdFor(session),
          });
          // One `SqliteStorePort.write` over one `immediate` transaction.
          const started = Bun.nanoseconds();
          const written = repositories.turns.insert(record);
          transactionSamples.push(Bun.nanoseconds() - started);
          expect(written.ok).toBe(true);

          expect(
            repositories.modelAttempts.insert(
              modelAttemptRecord({
                modelAttemptId: attemptIdFor(session, turn),
                turnId: turnIdFor(session, turn),
              }),
            ).ok,
          ).toBe(true);
          expect(
            repositories.invocations.insert(
              invocationRecord({
                invocationId: invocationIdFor(session, turn),
                turnId: turnIdFor(session, turn),
              }),
            ).ok,
          ).toBe(true);

          for (const event of eventsForTurn(
            streamFor(session),
            `s${session}t${turn}`,
            turn * EVENTS_PER_TURN + 1,
          )) {
            const appended = await events.append(event);
            expect(appended.ok && appended.value.kind).toBe("appended");
          }
        }
      }

      // Every row the size number is about, counted rather than assumed.
      expect(countIn(store, SESSIONS_TABLE)).toBe(SESSIONS);
      expect(countIn(store, TURNS_TABLE)).toBe(TURNS);
      expect(countIn(store, MODEL_ATTEMPTS_TABLE)).toBe(TURNS);
      expect(countIn(store, INVOCATIONS_TABLE)).toBe(TURNS);
      expect(countIn(store, EVENTS_TABLE)).toBe(EVENTS);

      report({
        quantity: "transaction latency",
        against: "`SqliteStorePort.write` over one `immediate` transaction, via `turns.insert`",
        dataset: `${TURNS} turn rows written into a database already holding ${SESSIONS} sessions`,
        state: "warm",
        result: formatDistribution(distribution(transactionSamples)),
        notes: [
          `the ${SESSIONS} session inserts preceding these are the discarded warm-up`,
          "each sample is one transaction: the existence check and the insert commit together",
        ],
      });

      // Closed before the file is measured: the close sequence disables
      // persistent WAL and truncates the log, so the number is the database
      // rather than the database plus a sidecar that is about to disappear.
      const closed = await store.close();
      expect(closed.closed).toBe(true);

      const path = sqliteDatabasePath(root);
      if (path === null) {
        unmeasured("database size", "the temporary root did not produce a database path");
      }
      const size = (await stat(path)).size;
      expect(size).toBeGreaterThan(0);

      report({
        quantity: "database size",
        against: "the `falryn.sqlite` file after the declared dataset is written and closed",
        dataset:
          `${SESSIONS} sessions, ${TURNS} turns, ${TURNS} model attempts, ${TURNS} invocations, ` +
          `${EVENTS} events at schema version ${PRODUCT_SCHEMA_VERSION}`,
        state: "cold",
        result: `${size} bytes (${mebibytes(size)}) for ${SESSIONS + TURNS * 3 + EVENTS} rows`,
        notes: [
          "measured after the close sequence truncated the write-ahead log, so no `-wal` or `-shm` is included",
          "artifact bytes live outside the database and are not part of this number",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures busy wait and the refusal rate under real contention",
    async () => {
      const root = await temporaryRoot("falryn-measure-contention-");
      const path = sqliteDatabasePath(root);
      if (path === null) {
        unmeasured("busy wait and refusal rate", "the temporary root did not produce a path");
      }

      // ── Waits, then succeeds: a hold well inside the default timeout ───────
      const patient = await openStore(root, DEFAULT_BUSY_TIMEOUT_MS);
      const patientRepositories = createRecordRepositories(patient);
      const waited: number[] = [];
      let refusedWhileWaiting = 0;
      const waitingCodes = new Set<string>();

      for (let sample = 0; sample < CONTENTION_SAMPLES; sample += 1) {
        const holder = await holdWriteLock(path, SHORT_HOLD_MS);
        const started = Bun.nanoseconds();
        const written = patientRepositories.sessions.insert(
          sessionRecord({
            sessionId: sessionIdFor(sample),
            streamId: streamFor(sample),
            title: `contended session ${sample}`,
          }),
        );
        waited.push(Bun.nanoseconds() - started);
        if (!written.ok) {
          refusedWhileWaiting += 1;
          waitingCodes.add(driverCodeOf(written.error));
        }
        await holder.released;
      }

      expect(countIn(patient, SESSIONS_TABLE)).toBe(CONTENTION_SAMPLES - refusedWhileWaiting);
      await patient.close();

      report({
        quantity: "busy wait",
        against: "a second process holding `BEGIN IMMEDIATE` while this one commits one row",
        dataset: `${CONTENTION_SAMPLES} contended inserts, each against a ${SHORT_HOLD_MS} ms hold`,
        state: "warm",
        result: `${formatDistribution(distribution(waited))} | refused ${refusedWhileWaiting}/${CONTENTION_SAMPLES}${
          refusedWhileWaiting === 0 ? "" : ` (${[...waitingCodes].join(", ")})`
        }`,
        notes: [
          `the configured busy timeout was ${DEFAULT_BUSY_TIMEOUT_MS} ms`,
          "the wait happens inside SQLite's own busy handler; Falryn performs no application-level retry",
        ],
      });

      // ── Refused: a hold that outlasts a deliberately short timeout ─────────
      const impatient = await openStore(root, SHORT_BUSY_TIMEOUT_MS);
      const impatientRepositories = createRecordRepositories(impatient);
      const refusalWaits: number[] = [];
      let refused = 0;
      const codes = new Set<string>();

      for (let sample = 0; sample < CONTENTION_SAMPLES; sample += 1) {
        const holder = await holdWriteLock(path, LONG_HOLD_MS);
        const started = Bun.nanoseconds();
        const written = impatientRepositories.sessions.insert(
          sessionRecord({
            sessionId: sessionId.from(`refused-session-${sample}`),
            streamId: streamId.from(`session:refused-${sample}`),
            title: `refused session ${sample}`,
          }),
        );
        refusalWaits.push(Bun.nanoseconds() - started);
        if (!written.ok) {
          refused += 1;
          codes.add(driverCodeOf(written.error));
        }
        await holder.released;
      }

      // The refusals are the measurement, so a run where nothing was refused
      // measured something other than a refusal rate.
      expect(refused).toBe(CONTENTION_SAMPLES);
      expect([...codes]).toEqual(["busy"]);
      // Nothing the refused writes attempted reached the file.
      expect(countIn(impatient, SESSIONS_TABLE)).toBe(CONTENTION_SAMPLES - refusedWhileWaiting);
      await impatient.close();

      report({
        quantity: "refusal rate",
        against: "the same contention against a store configured with a short busy timeout",
        dataset: `${CONTENTION_SAMPLES} contended inserts, each against a ${LONG_HOLD_MS} ms hold`,
        state: "warm",
        result: `refused ${refused}/${CONTENTION_SAMPLES} | ${formatDistribution(distribution(refusalWaits))}`,
        notes: [
          `the configured busy timeout was ${SHORT_BUSY_TIMEOUT_MS} ms, so each attempt exhausts it and is refused`,
          "the refusal is reported as `busy` with effect `none`; nothing is retried and nothing was written",
        ],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures artifact throughput and range-read latency against the host blob adapter",
    async () => {
      const root = await temporaryRoot("falryn-measure-artifacts-");
      const store = await openStore(root);

      // This run's row, before anything reserves: the schema will not accept a
      // reserved artifact naming no run. Outside every measured window.
      const run = beginRun({
        store,
        clock: createManualClock(FIXTURE_INSTANT),
        runId: runIdCodec.from("run-measurement"),
      });
      if (!run.ok) {
        throw new Error(`expected the run to be recorded: ${run.error.code}`);
      }

      const artifacts = createArtifactStore({
        repository: createArtifactRepository(store, run.value.record.runId),
        // The host adapter over a real temporary root, never the in-memory
        // double: a throughput number taken against memory measures RAM.
        blobs: blobStoreIn(root),
        hasher: createSha256Hasher(),
        clock: createManualClock(FIXTURE_INSTANT),
      });

      const ingestSamples: number[] = [];
      const digests = new Set<string>();
      let lastId: ArtifactId | null = null;
      let lastSample = 0;

      for (let sample = 0; sample < ARTIFACT_SAMPLES; sample += 1) {
        const bytes = artifactBytes(sample);
        const id = artifactId.from(`measure-artifact-${sample}`);
        const started = Bun.nanoseconds();
        const ingested = await artifacts.ingest({
          artifactId: id,
          mediaType: "application/octet-stream",
          encoding: "identity",
          sensitivity: "user-content",
          origin: "tool-output",
          invocationId: null,
          declaredByteLength: bytes.byteLength,
          content: inChunks(bytes),
        });
        ingestSamples.push(Bun.nanoseconds() - started);

        if (!ingested.ok) {
          unmeasured("artifact throughput", `ingest failed: ${ingested.error.code}`);
        }
        expect(ingested.value.record.availability).toBe("available");
        expect(ingested.value.record.byteLength).toBe(ARTIFACT_BYTES);
        expect(ingested.value.record.finalizedAt).not.toBeNull();
        digests.add(ingested.value.record.digest);
        lastId = id;
        lastSample = sample;
      }

      // Distinct bytes produced distinct digests, so no sample was deduplicated
      // into a finalize that never wrote anything.
      expect(digests.size).toBe(ARTIFACT_SAMPLES);
      expect(countIn(store, ARTIFACTS_TABLE)).toBe(ARTIFACT_SAMPLES);

      const throughput = distribution(ingestSamples);
      const medianBytesPerSecond = ARTIFACT_BYTES / (throughput.medianMs / 1_000);
      report({
        quantity: "artifact throughput",
        against:
          "`ArtifactStorePort.ingest` through atomic finalize, over `createHostBlobStore` on a real temporary root",
        dataset: `${ARTIFACT_SAMPLES} artifacts of ${mebibytes(ARTIFACT_BYTES)} each, streamed in ${binarySize(ARTIFACT_CHUNK_BYTES)} chunks`,
        state: "cold and warm",
        result: `${formatDistribution(throughput)} | median ${mebibytes(medianBytesPerSecond)}/s`,
        notes: [
          "includes the SHA-256 digest pass, because that is what a caller waits for",
          "the first sample is cold and is kept rather than discarded, which is why the spread is reported",
        ],
      });

      if (lastId === null) {
        unmeasured("range-read latency", "no artifact was finalized to read from");
      }
      const readable = lastId;
      // One byte past the read length, so no sampled offset is a multiple of it
      // and no two samples share a residue mod 256. An aligned stride would
      // make every byte-identity assertion below resolve to the same expected
      // value whatever offset was actually read — an assertion that passes for
      // a reason unrelated to the offset is not an assertion.
      const stride = RANGE_BYTES + 1;
      const positions = ARTIFACT_BYTES - RANGE_BYTES;

      // One discarded warm-up, then the samples.
      const warmUp = await artifacts.readRange(readable, 0, RANGE_BYTES);
      expect(warmUp.ok).toBe(true);

      const rangeSamples: number[] = [];
      for (let sample = 0; sample < RANGE_SAMPLES; sample += 1) {
        const offset = (sample * stride) % positions;
        const started = Bun.nanoseconds();
        const range = await artifacts.readRange(readable, offset, RANGE_BYTES);
        rangeSamples.push(Bun.nanoseconds() - started);
        if (!range.ok) {
          unmeasured("range-read latency", `readRange failed: ${range.error.code}`);
        }
        expect(range.value.bytes.byteLength).toBe(RANGE_BYTES);
        // The bytes are the ones that were written, so the number describes a
        // real read rather than an empty one.
        // Both ends, so a read that returned the right length from the wrong
        // place fails rather than passing on its first byte.
        expect(range.value.bytes[0]).toBe((offset + lastSample) % 256);
        expect(range.value.bytes[RANGE_BYTES - 1]).toBe(
          (offset + RANGE_BYTES - 1 + lastSample) % 256,
        );
      }

      report({
        quantity: "range-read latency",
        against:
          "`ArtifactStorePort.readRange` over `createHostBlobStore` on a real temporary root",
        dataset: `${RANGE_SAMPLES} bounded reads of ${binarySize(RANGE_BYTES)} at rotating offsets in one ${mebibytes(ARTIFACT_BYTES)} artifact`,
        state: "warm",
        result: formatDistribution(distribution(rangeSamples)),
        notes: [
          "one read is discarded as the warm-up before the samples are taken",
          "includes the metadata read that resolves the artifact to its digest",
        ],
      });

      await store.close();
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

describe.if(!MEASURING)("persistence resource behavior", () => {
  test.skip("was not measured, because FALRYN_MEASURE is not set — run `bun run measure`", () => {
    // Recorded as skipped rather than silently absent. The measurement is
    // deliberately outside `bun run check` and `bun run ci`: it asserts no
    // timing threshold, and a threshold needs the benchmark harness this
    // repository does not have an owner for yet.
  });
});
