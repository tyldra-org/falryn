/**
 * The persistence resource measurement.
 *
 * The persistence resource measurements that were previously asserted rather than measured:
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
 *   neither `check` nor `ci`. A caller that supplies
 *   `FALRYN_MEASURE_REPORT` receives a bounded report for the four signals the
 *   comparative CI gate owns; ordinary local diagnostics remain threshold-free.
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
import { cpus, release, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { TestRecorder } from "@opentui/core/testing";
import { createElement, type ReactNode } from "react";

import {
  BENCHMARK_METRIC_IDS,
  BENCHMARK_TRIALS,
  type BenchmarkMeasurement,
  type BenchmarkMetricId,
  type BenchmarkRun,
  type BenchmarkTrial,
  createBenchmarkMeasurement,
  createBenchmarkReport,
  writeBenchmarkReport,
} from "../../tools/benchmark-regression.ts";
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
import type { ScopeEvent, TerminalOutcome } from "../domain/index.ts";
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
import { scopeEvent } from "../presentation/activity/fixtures.ts";
import {
  EMPTY_PROJECTION,
  type TranscriptBlock,
  type TranscriptProjection,
} from "../presentation/index.ts";
import { everyBlockKind, FIXTURE_AT } from "../presentation/transcript/fixtures.ts";
import { ShellApp } from "../tui/components/shell-app.tsx";
import { countRenderables, frameOf, mount, type TerminalShape } from "../tui/harness.tsx";
import {
  measuredExecutableExists,
  openMeasurementPty,
  startCompiledMeasurement,
} from "../tui/measurement-fixtures.ts";
import { type RuntimeFeed, useRuntimeProjection } from "../tui/runtime-feed.ts";
import type { ThemeRequest } from "../tui/theme/index.ts";
import type { ShellModel } from "../tui/view-model.ts";
import { known, unavailable } from "../tui/view-model.ts";
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

/** Set by `bun run measure`. Anything else leaves the module visibly skipped. */
const measuring = process.env.FALRYN_MEASURE === "1";

/** Compiled measurements are skipped when the artifact or a pseudo-terminal is unavailable. */
const compiledMeasurementReady =
  measuring &&
  (await measuredExecutableExists()) &&
  (() => {
    const pty = openMeasurementPty();
    pty?.close();
    return pty !== null;
  })();

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

/** Contending attempts per scenario. Fixed, so the measurement terminates. */
const CONTENTION_SAMPLES = 5;

/** How long the second process holds the write lock in each scenario. */
const SHORT_HOLD_MS = 300;
const LONG_HOLD_MS = 2_000;

/** The timeout the refusal scenario runs under, above `MIN_BUSY_TIMEOUT_MS`. */
const SHORT_BUSY_TIMEOUT_MS = 300;

const MEASUREMENT_TIMEOUT_MS = 300_000;

// ── Reporting ───────────────────────────────────────────────────────────────

type Distribution = {
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

function milliseconds(nanoseconds: number): number {
  return nanoseconds / 1_000_000;
}

function rounded(value: number): string {
  return value.toFixed(3);
}

/**
 * Median and spread rather than a mean.
 *
 * A mean over a bimodal set is the one summary that hides contention, which is
 * precisely the shape half of these quantities have.
 */
function distribution(samplesNs: readonly number[]): Distribution {
  const sorted = [...samplesNs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    minMs: milliseconds(sorted[0] ?? 0),
    medianMs: milliseconds(median),
    p95Ms: milliseconds(sorted[p95Index] ?? 0),
    maxMs: milliseconds(sorted[sorted.length - 1] ?? 0),
  };
}

function formatDistribution(value: Distribution): string {
  return [
    `samples ${value.count}`,
    `min ${rounded(value.minMs)} ms`,
    `median ${rounded(value.medianMs)} ms`,
    `p95 ${rounded(value.p95Ms)} ms`,
    `max ${rounded(value.maxMs)} ms`,
  ].join(" | ");
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1_024 * 1_024)).toFixed(2)} MiB`;
}

/** KiB below a mebibyte, so a 64 KiB read is not reported as `0.06 MiB`. */
function binarySize(bytes: number): string {
  return bytes < 1_024 * 1_024 ? `${(bytes / 1_024).toFixed(0)} KiB` : mebibytes(bytes);
}

/** The five qualifiers a recorded performance number has to carry. */
type Measurement = {
  readonly quantity: string;
  readonly against: string;
  readonly dataset: string;
  readonly state: "cold" | "warm" | "cold and warm";
  readonly result: string;
  readonly notes?: readonly string[];
  readonly benchmark?: BenchmarkMeasurement;
};

const EXPECTED_MEASUREMENTS = [
  "migration time",
  "transaction latency",
  "database size",
  "busy wait",
  "refusal rate",
  "artifact throughput",
  "range-read latency",
  "startup to first draw",
  "render cadence",
  "input latency under stream load",
  "event-loop delay",
  "memory growth across a long transcript",
  "shutdown latency",
] as const;

const reportedMeasurements = new Set<string>();
const benchmarkMeasurements = new Map<BenchmarkMetricId, BenchmarkMeasurement>();

function configuredReportPath(): string | null {
  const destination = process.env.FALRYN_MEASURE_REPORT;
  if (destination === undefined) {
    return null;
  }
  if (!measuring) {
    throw new Error("FALRYN_MEASURE_REPORT requires FALRYN_MEASURE=1");
  }
  if (
    destination.trim().length === 0 ||
    destination !== destination.trim() ||
    !isAbsolute(destination)
  ) {
    throw new Error("FALRYN_MEASURE_REPORT must be a non-empty absolute file path");
  }
  return destination;
}

const reportPath = configuredReportPath();

/**
 * A comparative report needs enough observations for its p95 to describe the
 * measured operation rather than one scheduler interruption. Local diagnostics
 * retain their short, bounded profile; CI's four equivalent report trials use
 * the larger profile and record the resulting sample arrays and dataset ids.
 */
const COMPARISON_COLD_SAMPLES = 21;
const COMPARISON_RANGE_SAMPLES = 256;
const MIGRATION_SAMPLES = reportPath === null ? 5 : COMPARISON_COLD_SAMPLES;
const RANGE_SAMPLES = reportPath === null ? 64 : COMPARISON_RANGE_SAMPLES;

function configuredBenchmarkRun(): BenchmarkRun {
  const revision = process.env.FALRYN_BENCHMARK_REVISION ?? "manual";
  const trial = process.env.FALRYN_BENCHMARK_TRIAL ?? "manual";
  const warmupRunsSource = process.env.FALRYN_BENCHMARK_WARMUP_RUNS ?? "0";
  const warmupRuns = Number(warmupRunsSource);
  if (
    revision.trim().length === 0 ||
    !BENCHMARK_TRIALS.includes(trial as BenchmarkTrial) ||
    !Number.isInteger(warmupRuns) ||
    warmupRuns < 0
  ) {
    throw new Error("benchmark report run metadata is invalid");
  }
  return { revision, trial: trial as BenchmarkTrial, warmupRuns };
}

function platformLine(): string {
  const model = cpus()[0]?.model ?? "unknown cpu";
  const cores = cpus().length;
  return [
    `${process.platform} ${process.arch} ${release()}`,
    `${model} (${cores} logical cores)`,
    `${(totalmem() / (1_024 * 1_024 * 1_024)).toFixed(0)} GiB RAM`,
    `Bun ${Bun.version}`,
  ].join(" | ");
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function report(measurement: Measurement): void {
  if (measuring) {
    if (
      !EXPECTED_MEASUREMENTS.includes(
        measurement.quantity as (typeof EXPECTED_MEASUREMENTS)[number],
      )
    ) {
      throw new Error(`unexpected measurement report: ${measurement.quantity}`);
    }
    if (reportedMeasurements.has(measurement.quantity)) {
      throw new Error(`duplicate measurement report: ${measurement.quantity}`);
    }
    reportedMeasurements.add(measurement.quantity);
    if (measurement.benchmark !== undefined) {
      if (benchmarkMeasurements.has(measurement.benchmark.id)) {
        throw new Error(`duplicate benchmark measurement: ${measurement.benchmark.id}`);
      }
      benchmarkMeasurements.set(measurement.benchmark.id, measurement.benchmark);
    }
  }
  write("");
  write(`── ${measurement.quantity} ──`);
  write(`   against   ${measurement.against}`);
  write(`   dataset   ${measurement.dataset}`);
  write(`   state     ${measurement.state}`);
  write(`   platform  ${platformLine()}`);
  write(`   result    ${measurement.result}`);
  for (const note of measurement.notes ?? []) {
    write(`   note      ${note}`);
  }
}

function benchmarkMilliseconds(
  id: BenchmarkMetricId,
  datasetRevision: string,
  state: Measurement["state"],
  samples: readonly number[],
): BenchmarkMeasurement {
  return createBenchmarkMeasurement({
    id,
    datasetRevision,
    state,
    samples,
  });
}

function benchmarkNanoseconds(
  id: BenchmarkMetricId,
  datasetRevision: string,
  state: Measurement["state"],
  samples: readonly number[],
): BenchmarkMeasurement {
  return benchmarkMilliseconds(
    id,
    datasetRevision,
    state,
    samples.map((sample) => milliseconds(sample)),
  );
}

afterAll(async () => {
  try {
    if (reportPath === null) {
      return;
    }
    if (!compiledMeasurementReady) {
      throw new Error(
        "compiled executable or pseudo-terminal unavailable; no benchmark report was written",
      );
    }
    const missingMeasurements = EXPECTED_MEASUREMENTS.filter(
      (quantity) => !reportedMeasurements.has(quantity),
    );
    if (missingMeasurements.length > 0) {
      throw new Error(
        `measurement suite was incomplete; no benchmark report was written: ${missingMeasurements.join(", ")}`,
      );
    }
    const missingBenchmarks = BENCHMARK_METRIC_IDS.filter((id) => !benchmarkMeasurements.has(id));
    if (missingBenchmarks.length > 0) {
      throw new Error(
        `benchmark measurements were incomplete; no report was written: ${missingBenchmarks.join(", ")}`,
      );
    }
    const measurements = BENCHMARK_METRIC_IDS.map((id) => {
      const measurement = benchmarkMeasurements.get(id);
      if (measurement === undefined) {
        throw new Error(`benchmark measurement disappeared before reporting: ${id}`);
      }
      return measurement;
    });
    await writeBenchmarkReport(
      reportPath,
      createBenchmarkReport(measurements, undefined, configuredBenchmarkRun()),
    );
  } finally {
    await removeTemporaryRoots();
  }
});

/**
 * Records a quantity that could not be measured, with the reason.
 *
 * Then throws it, so the run that could not measure it fails rather than
 * finishing quietly. A missing number that reads as a fast number is the exact
 * failure this module exists to prevent.
 */
function unmeasured(quantity: string, reason: string): never {
  write("");
  write(`── ${quantity} ──`);
  write(`   result    UNMEASURED`);
  write(`   reason    ${reason}`);
  throw new Error(`${quantity} could not be measured: ${reason}`);
}

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

describe.if(measuring)("persistence resource behavior", () => {
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
        benchmark: benchmarkNanoseconds(
          "migration-time",
          `sqlite-schema-${PRODUCT_SCHEMA_VERSION}-empty-v1`,
          "cold",
          samples,
        ),
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
        benchmark: benchmarkNanoseconds(
          "transaction-latency",
          `sqlite-schema-${PRODUCT_SCHEMA_VERSION}-sessions-${SESSIONS}-turns-${TURNS}-events-${EVENTS}-v1`,
          "warm",
          transactionSamples,
        ),
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

      await store.close();

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
        benchmark: benchmarkNanoseconds(
          "range-read-latency",
          `host-blob-${ARTIFACT_BYTES}-byte-artifact-${RANGE_BYTES}-byte-ranges-${RANGE_SAMPLES}-samples-v1`,
          "warm",
          rangeSamples,
        ),
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

// ── Shell measurements ──────────────────────────────────────────────────────

const SHELL_THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const SHELL_MODEL: Omit<
  ShellModel,
  "overlay" | "commands" | "transcript" | "composer" | "activity"
> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

const MEASURE_SHAPE: TerminalShape = { columns: 100, rows: 30 };
const STREAM_UPDATES = 96;
const LONG_TRANSCRIPT_BLOCKS = 2_000;
const SHELL_SAMPLES = 5;
const STARTUP_SAMPLES = reportPath === null ? SHELL_SAMPLES : COMPARISON_COLD_SAMPLES;

function shellNode(transcript: TranscriptProjection = EMPTY_PROJECTION): ReactNode {
  return createElement(ShellApp, {
    theme: SHELL_THEME,
    model: SHELL_MODEL,
    onExit: () => {},
    transcript,
  });
}

/** A bounded, distinguishable transcript that exercises the virtualized surface. */
function transcriptHistory(count: number): TranscriptProjection {
  const notice = everyBlockKind().find(
    (block): block is Extract<TranscriptBlock, { readonly kind: "notice" }> =>
      block.kind === "notice",
  );
  if (notice === undefined) {
    throw new Error("the transcript corpus no longer has a notice block");
  }
  return {
    ...EMPTY_PROJECTION,
    blocks: Array.from({ length: count }, (_unused, order) => ({
      ...notice,
      anchor: { of: "declared", key: `measure-entry-${order}` },
      occurredAt: FIXTURE_AT,
      order,
    })),
  };
}

function formatMilliseconds(samples: readonly number[]): string {
  return formatDistribution(distribution(samples.map((sample) => sample * 1_000_000)));
}

/** A distribution for memory deltas, which are not durations. */
function formatBytes(samples: readonly number[]): string {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  return [
    `samples ${sorted.length}`,
    `min ${binarySize(sorted[0] ?? 0)}`,
    `median ${binarySize(median)}`,
    `p95 ${binarySize(p95)}`,
    `max ${binarySize(sorted[sorted.length - 1] ?? 0)}`,
  ].join(" | ");
}

function formatIntegers(samples: readonly number[]): string {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  return [
    `samples ${sorted.length}`,
    `min ${sorted[0] ?? 0}`,
    `median ${median}`,
    `p95 ${p95}`,
    `max ${sorted[sorted.length - 1] ?? 0}`,
  ].join(" | ");
}

type CompiledMeasurementRun = NonNullable<Awaited<ReturnType<typeof startCompiledMeasurement>>>;

async function compiledSample(
  action: (run: CompiledMeasurementRun) => Promise<number>,
): Promise<number> {
  const run = await startCompiledMeasurement();
  if (run === null) {
    throw new Error("the compiled measurement was marked ready but could not start");
  }
  let actionFailed = false;
  let actionError: unknown;
  let result: number | undefined;
  try {
    result = await action(run);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  const exitCode = await run.stop();
  if (actionFailed) {
    throw actionError;
  }
  if (exitCode === "timed-out") {
    throw new Error("the compiled measurement did not shut down");
  }
  if (result === undefined) {
    throw new Error("the compiled measurement returned no result");
  }
  return result;
}

describe.if(measuring && compiledMeasurementReady)("compiled shell measurements", () => {
  test(
    "measures startup to first draw on the compiled pseudo-terminal",
    async () => {
      const samples: number[] = [];
      for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) {
        samples.push(await compiledSample(async (run) => (await run.waitForFrame()).elapsedMs));
      }
      expect(samples).toHaveLength(STARTUP_SAMPLES);
      report({
        quantity: "startup to first draw",
        against: "`dist/falryn` spawned on a pseudo-terminal until its first synchronized frame",
        dataset: `${STARTUP_SAMPLES} cold compiled-process starts at ${MEASURE_SHAPE.columns}×${MEASURE_SHAPE.rows}`,
        state: "cold",
        result: formatMilliseconds(samples),
        notes: ["the clock starts before process spawn, so executable startup is included"],
        benchmark: benchmarkMilliseconds(
          "startup-to-first-draw",
          `compiled-shell-${MEASURE_SHAPE.columns}x${MEASURE_SHAPE.rows}-${STARTUP_SAMPLES}-starts-v1`,
          "cold",
          samples,
        ),
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures render cadence on the compiled pseudo-terminal",
    async () => {
      const samples: number[] = [];
      const frames: number[] = [];
      for (let sample = 0; sample < SHELL_SAMPLES; sample += 1) {
        const run = await startCompiledMeasurement();
        if (run === null) {
          throw new Error("the compiled measurement was marked ready but could not start");
        }
        let timedOut = false;
        try {
          await run.waitForFrame();
          await run.waitForQuiet();
          // The compiled walk uses two tabs to focus the composer. Do that before
          // taking the baseline so the cadence number is for the measured burst.
          run.write("\t\t");
          await run.waitForQuiet();
          const before = run.frameCount();
          const started = performance.now();
          run.write("x".repeat(STREAM_UPDATES));
          await run.waitForQuiet();
          const count = run.frameCount() - before;
          expect(count).toBeGreaterThan(0);
          frames.push(count);
          samples.push((performance.now() - started) / count);
        } finally {
          const exitCode = await run.stop();
          timedOut = exitCode === "timed-out";
        }
        if (timedOut) {
          throw new Error("the compiled cadence sample did not shut down");
        }
      }
      report({
        quantity: "render cadence",
        against:
          "native synchronized frames emitted by `dist/falryn` during a terminal input burst",
        dataset: `${SHELL_SAMPLES} runs × ${STREAM_UPDATES} bytes, frames counted from the pty transcript`,
        state: "warm",
        result: `${formatMilliseconds(samples)} | frames ${formatIntegers(frames)}`,
        notes: ["a test renderer is not used because it does not run OpenTUI's frame loop"],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

describe.if(measuring)("in-process shell measurements", () => {
  test(
    "measures input latency under stream load through the shared harness",
    async () => {
      const samples: number[] = [];

      for (let sample = 0; sample < SHELL_SAMPLES; sample += 1) {
        const rendered = await mount(shellNode(transcriptHistory(STREAM_UPDATES + sample)), {
          shape: MEASURE_SHAPE,
        });
        try {
          await rendered.frame();
          // The transcript load is present before the focus sequence. The key
          // itself is timed only after the shared harness has settled the shell.
          await rendered.pressTab();
          await rendered.pressTab();
          const before = rendered.setup.captureCharFrame();
          const started = performance.now();
          rendered.setup.mockInput.pressKey("x");
          const after = await rendered.frame();
          samples.push(performance.now() - started);
          expect(after).not.toBe(before);
        } finally {
          rendered[Symbol.dispose]();
        }
      }

      report({
        quantity: "input latency under stream load",
        against: "a mounted `ShellApp` driven by the shared OpenTUI harness",
        dataset: `${SHELL_SAMPLES} keypresses while ${STREAM_UPDATES} transcript updates are present`,
        state: "warm",
        result: formatMilliseconds(samples),
        notes: ["the frame is settled through `mount`, not a fixed flush count"],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures event-loop delay while the mounted shell handles a burst",
    async () => {
      // Warm the renderer once through the one-shot harness path. The measured
      // samples below retain a renderer so the load is applied to one shell.
      await frameOf(shellNode(transcriptHistory(16)), { shape: MEASURE_SHAPE });
      const samples: number[] = [];
      using rendered = await mount(shellNode(), { shape: MEASURE_SHAPE });
      await rendered.frame();
      await rendered.pressTab();
      await rendered.pressTab();

      for (let sample = 0; sample < SHELL_SAMPLES; sample += 1) {
        const started = performance.now();
        const delayed = new Promise<number>((resolve) => {
          setTimeout(() => resolve(performance.now() - started), 0);
        });
        for (let update = 0; update < STREAM_UPDATES; update += 1) {
          rendered.setup.mockInput.pressKey("x");
        }
        await rendered.setup.flush();
        samples.push(await delayed);
        await rendered.frame();
      }

      report({
        quantity: "event-loop delay",
        against: "the host event loop while a mounted shell receives a synchronous input burst",
        dataset: `${SHELL_SAMPLES} samples × ${STREAM_UPDATES} queued key events`,
        state: "warm",
        result: formatMilliseconds(samples),
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures memory growth across a long transcript",
    async () => {
      const samples: number[] = [];
      const renderables: number[] = [];
      for (let sample = 0; sample < SHELL_SAMPLES; sample += 1) {
        const rendered = await mount(shellNode(), { shape: MEASURE_SHAPE });
        let disposed = false;
        try {
          await rendered.frame();
          const before = process.memoryUsage().heapUsed;
          await rendered.show(shellNode(transcriptHistory(LONG_TRANSCRIPT_BLOCKS + sample)));
          const after = process.memoryUsage().heapUsed;
          renderables.push(countRenderables(rendered.setup.renderer.root));
          samples.push(after - before);
        } finally {
          rendered[Symbol.dispose]();
          disposed = true;
          expect(disposed).toBe(true);
        }
      }
      expect(renderables.every((count) => count > 1)).toBe(true);
      report({
        quantity: "memory growth across a long transcript",
        against: "a mounted `ShellApp` with the transcript surface's virtualized window",
        dataset: `${SHELL_SAMPLES} mounts × ${LONG_TRANSCRIPT_BLOCKS} blocks (plus one per sample)`,
        state: "cold and warm",
        result: `${formatBytes(samples)} | renderables ${formatIntegers(renderables)}`,
        notes: ["the count proves a tree drew the transcript; no memory threshold is asserted"],
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );

  test(
    "measures shutdown latency through harness-owned renderer disposal",
    async () => {
      const samples: number[] = [];
      for (let sample = 0; sample < SHELL_SAMPLES; sample += 1) {
        const rendered = await mount(shellNode(transcriptHistory(16)), { shape: MEASURE_SHAPE });
        let disposed = false;
        try {
          await rendered.frame();
          const started = performance.now();
          rendered[Symbol.dispose]();
          disposed = true;
          samples.push(performance.now() - started);
        } finally {
          if (!disposed) {
            rendered[Symbol.dispose]();
          }
        }
      }
      report({
        quantity: "shutdown latency",
        against: "the shared harness unmount and OpenTUI renderer destruction",
        dataset: `${SHELL_SAMPLES} mounted shells with a 16-block transcript`,
        state: "warm",
        result: formatMilliseconds(samples),
      });
    },
    MEASUREMENT_TIMEOUT_MS,
  );
});

// ── Mounted-shell coalescing ────────────────────────────────────────────────

type BurstFeed = {
  readonly feed: RuntimeFeed;
  append(events: readonly ScopeEvent[]): void;
};

function burstFeed(): BurstFeed {
  const events: ScopeEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    feed: {
      events: () => events,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      shutdown: () => null,
    },
    append(next) {
      events.push(...next);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const BURST_OUTCOMES: readonly TerminalOutcome[] = [
  { kind: "completed" },
  { kind: "failed", effect: "none" },
  { kind: "cancelled", effect: "partial" },
  { kind: "timed-out", effect: "none" },
  { kind: "uncertain", effect: "uncertain" },
];

function burstEvents(): readonly ScopeEvent[] {
  return BURST_OUTCOMES.flatMap((outcome, index) => {
    const scope = `burst-${outcome.kind}`;
    return [
      scopeEvent({ order: index * 2, kind: "scope.opened", scope }),
      scopeEvent({ order: index * 2 + 1, kind: "scope.terminal", scope, outcome }),
    ];
  });
}

function BurstShell(props: { readonly feed: RuntimeFeed }): ReactNode {
  const runtime = useRuntimeProjection(props.feed);
  return createElement(ShellApp, {
    theme: SHELL_THEME,
    model: SHELL_MODEL,
    onExit: () => {},
    activity: runtime.activity,
  });
}

function assertSemanticOutcomes(frame: string): void {
  for (const outcome of BURST_OUTCOMES) {
    expect(frame).toContain(`invocation ${outcome.kind}`);
  }
}

async function mountedBurst(swallowTerminalFor: string | null = null): Promise<{
  readonly frame: string;
  readonly events: number;
  readonly frames: number;
}> {
  const source = burstFeed();
  using rendered = await mount(createElement(BurstShell, { feed: source.feed }), {
    shape: { columns: 140, rows: 30 },
  });
  await rendered.frame();
  const events = burstEvents();
  const recorder = new TestRecorder(rendered.setup.renderer);
  recorder.rec();
  for (const event of events) {
    if (
      event.kind === "scope.terminal" &&
      String(event.scopeId) === `scope-${swallowTerminalFor}`
    ) {
      continue;
    }
    source.append([event]);
  }
  const frame = await rendered.frame();
  recorder.stop();
  return { frame, events: events.length, frames: recorder.recordedFrames.length };
}

test(
  "keeps every semantic outcome visible through a coalesced mounted-shell burst",
  async () => {
    const observed = await mountedBurst();
    expect(observed.frames).toBeGreaterThan(0);
    expect(observed.frames).toBeLessThan(observed.events);
    assertSemanticOutcomes(observed.frame);

    // Negative control: swallowing one terminal event must make the same oracle
    // fail. This exercises the mounted shell, rather than repeating the reducer's
    // already-owned frame-invariance tests.
    const missing = await mountedBurst("burst-uncertain");
    expect(missing.frame).not.toContain("invocation uncertain");
    expect(() => assertSemanticOutcomes(missing.frame)).toThrow();
  },
  MEASUREMENT_TIMEOUT_MS,
);

describe.if(!measuring)("persistence resource behavior", () => {
  test.skip("was not measured, because FALRYN_MEASURE is not set — run `bun run measure`", () => {
    // Recorded as skipped rather than silently absent. The measurement is
    // deliberately outside `bun run check` and `bun run ci`: it asserts no
    // timing threshold, and a threshold needs the benchmark harness this
    // repository does not have an owner for yet.
  });
});
