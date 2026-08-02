/**
 * Startup recovery, against a real migrated database staged in each
 * interrupted state.
 *
 * The database is genuine and the bytes are staged in memory, so what these
 * check is the pass's decisions rather than a double's agreement. The states
 * are the ones a killed run actually leaves: a reserved artifact whose bytes
 * verify, whose bytes are corrupt, and whose bytes are gone; in-flight blobs
 * belonging to a run that ended, to one that never did, and to nothing at all;
 * and records that never reached a terminal outcome.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  type ArtifactRecoveryOutcome,
  artifactId,
  type ContentDigest,
  createInMemoryBlobStore,
  createManualClock,
  duration,
  instant,
  type ManualClock,
  type RecoveryReport,
  type RunId,
  runId,
  type SqliteStorePort,
  type TemporaryBlobOutcome,
} from "../domain/index.ts";
import { createSha256Hasher } from "../integrations/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
  reservedArtifact,
} from "./fixtures.ts";
import {
  beginRun,
  createRunShutdownParticipant,
  probeCrashSignals,
  recoverInterruptedWork,
} from "./recovery.ts";

afterEach(removeTemporaryRoots);

const START = 1_800_000_000_000;
const THIS_RUN = runId.from("run-this");
const ENDED_RUN = runId.from("run-ended");
const LIVE_RUN = runId.from("run-live");
const BYTES = new TextEncoder().encode("interrupted content");

function digestOf(bytes: Uint8Array): ContentDigest {
  const hasher = createSha256Hasher().create();
  hasher.update(bytes);
  return hasher.digest();
}

const DIGEST = digestOf(BYTES);

type Harness = {
  readonly store: SqliteStorePort;
  readonly blobs: ReturnType<typeof createInMemoryBlobStore>;
  readonly clock: ManualClock;
  recover(overrides?: {
    readonly recoveryWindowMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<RecoveryReport>;
};

async function harness(): Promise<Harness> {
  const root = await makeTemporaryRoot("falryn-recovery-");
  const store = await openProductStoreOrThrow(root);
  const blobs = createInMemoryBlobStore();
  const clock = createManualClock(instant(START));
  return {
    store,
    blobs,
    clock,
    recover: (overrides = {}) =>
      recoverInterruptedWork(
        {
          store,
          blobs,
          hasher: createSha256Hasher(),
          clock,
          runId: THIS_RUN,
          ...(overrides.recoveryWindowMs === undefined
            ? {}
            : { recoveryWindowMs: overrides.recoveryWindowMs }),
        },
        overrides.signal,
      ),
  };
}

function iso(offsetMs: number): string {
  return new Date(START + offsetMs).toISOString();
}

/** A run row, written directly so a test can choose whether it ever ended. */
function insertRun(
  store: SqliteStorePort,
  id: RunId,
  options: { readonly startedAt?: string; readonly endedAt?: string | null } = {},
): void {
  store.write((statements) =>
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, $startedAt, $endedAt, 3)`,
      {
        runId: id,
        startedAt: options.startedAt ?? iso(-60_000),
        endedAt: options.endedAt ?? null,
      },
    ),
  );
}

/** A reserved artifact, written directly so its owning run can be chosen. */
function insertReserved(
  store: SqliteStorePort,
  options: {
    readonly artifactId: string;
    readonly digest: ContentDigest;
    readonly byteLength: number;
    readonly runId: RunId | null;
  },
): void {
  store.write((statements) =>
    statements.run(
      `INSERT INTO artifacts (artifact_id, digest, media_type, encoding, byte_length,
         sensitivity, origin, invocation_id, created_at, finalized_at, availability, run_id)
       VALUES ($artifactId, $digest, 'text/plain', 'identity', $byteLength,
         'user-content', 'tool-output', NULL, $createdAt, NULL, 'reserved', $runId)`,
      {
        artifactId: options.artifactId,
        digest: options.digest,
        byteLength: options.byteLength,
        createdAt: iso(-30_000),
        runId: options.runId,
      },
    ),
  );
}

function availabilityOf(store: SqliteStorePort, id: string): string | null {
  const rows = store.read(
    "SELECT availability AS availability FROM artifacts WHERE artifact_id = $id",
    {
      id,
    },
  );
  const value = rows.ok ? rows.value[0]?.availability : undefined;
  return typeof value === "string" ? value : null;
}

function artifactCount(report: RecoveryReport, outcome: ArtifactRecoveryOutcome): number {
  return report.artifacts.find((entry) => entry.outcome === outcome)?.count ?? 0;
}

function blobCount(report: RecoveryReport, outcome: TemporaryBlobOutcome): number {
  return report.temporaryBlobs.find((entry) => entry.outcome === outcome)?.count ?? 0;
}

/** A session, turn, model attempt, and invocation, none of them terminal. */
function insertNonTerminalRecords(store: SqliteStorePort): void {
  store.write((statements) => {
    statements.run(
      `INSERT INTO sessions (session_id, workspace_id, stream_id, title,
         configuration_generation, started_at, closed_at, outcome_kind, outcome_effect)
       VALUES ('s', 'w', 'stream', NULL, 0, $at, NULL, NULL, NULL)`,
      { at: iso(-120_000) },
    );
    statements.run(
      `INSERT INTO turns (turn_id, session_id, parent_turn_id, started_at, completed_at,
         outcome_kind, outcome_effect)
       VALUES ('t', 's', NULL, $at, NULL, NULL, NULL)`,
      { at: iso(-120_000) },
    );
    statements.run(
      `INSERT INTO model_attempts (model_attempt_id, turn_id, provider_id, model_id,
         started_at, completed_at, outcome_kind, outcome_effect)
       VALUES ('m', 't', 'p', 'model', $at, NULL, NULL, NULL)`,
      { at: iso(-120_000) },
    );
    statements.run(
      `INSERT INTO invocations (invocation_id, turn_id, capability_id, capability_version,
         input_digest, started_at, completed_at, outcome_kind, outcome_effect)
       VALUES ('i', 't', 'read', 1, 'ab', $at, NULL, NULL, NULL)`,
      { at: iso(-120_000) },
    );
  });
}

describe("an artifact an earlier run left reserved", () => {
  test("becomes available when its bytes are there and verify", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    const report = await recover();

    expect(availabilityOf(store, "a1")).toBe("available");
    expect(artifactCount(report, "available")).toBe(1);
    expect(report.effect).toBe("completed");
    await store.close();
  });

  test("becomes quarantined when its bytes are there and do not verify", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    // The bytes on the device are not the bytes the record names.
    blobs.put(
      { scope: "content", digest: DIGEST },
      new TextEncoder().encode("something else!!!!!"),
    );

    const report = await recover();

    expect(availabilityOf(store, "a1")).toBe("quarantined");
    expect(artifactCount(report, "quarantined")).toBe(1);
    // Set aside, never deleted: they are the evidence of whatever went wrong.
    expect(blobs.locations().map((location) => location.scope)).toEqual(["quarantine"]);
    await store.close();
  });

  test("becomes missing when its bytes are not there at all", async () => {
    const { store, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });

    const report = await recover();

    // The one state #14 declared and deliberately left uninferred.
    expect(availabilityOf(store, "a1")).toBe("missing");
    expect(artifactCount(report, "missing")).toBe(1);
    await store.close();
  });

  test("becomes missing and discards the partial that never reached content", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("a1") }, BYTES.slice(0, 4));

    const report = await recover();

    expect(availabilityOf(store, "a1")).toBe("missing");
    // An unverified partial that never reached content: nothing references it
    // and nothing can complete it.
    expect(blobs.locations()).toEqual([]);
    expect(blobCount(report, "discarded")).toBe(1);
    await store.close();
  });

  test("is left alone when the run that reserved it never ended", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, LIVE_RUN, { endedAt: null });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: LIVE_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    const report = await recover();

    // Another process may be finishing this very ingest.
    expect(availabilityOf(store, "a1")).toBe("reserved");
    expect(artifactCount(report, "left-for-inspection")).toBe(1);
    await store.close();
  });

  test("is resolved when nothing attributes it, because no run can be writing it", async () => {
    const { store, blobs, recover } = await harness();
    // A row written under migration 0002, before run identity existed.
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: null,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    await recover();

    expect(availabilityOf(store, "a1")).toBe("available");
    await store.close();
  });

  test("is left for inspection when verifying it would exceed the read bound", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      // Larger than the whole pass may read. Startup has to finish.
      byteLength: 512 * 1_024 * 1_024,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    const report = await recover();

    expect(availabilityOf(store, "a1")).toBe("reserved");
    expect(report.completeness).toBe("partial");
    expect(artifactCount(report, "left-for-inspection")).toBe(1);
    await store.close();
  });
});

describe("a live process's ingest, staged through the production path", () => {
  test("is never resolved or removed by a second Falryn recovering", async () => {
    const { store, blobs, clock, recover } = await harness();
    // Everything here goes through the shipped repository rather than
    // hand-written SQL, so `run_id` holds exactly what production writes. A
    // test that stages the column itself proves the property only for data the
    // product never produces.
    const live = beginRun({ store, clock, runId: LIVE_RUN });
    if (!live.ok) {
      throw new Error("expected the live run to begin");
    }
    const repository = createArtifactRepository(store, LIVE_RUN);
    const reserved = repository.reserve(
      reservedArtifact("a1", DIGEST, { byteLength: BYTES.byteLength }),
    );
    expect(reserved.ok).toBe(true);
    // The window the real ingest leaves open: the row is committed and the
    // bytes have not been renamed into content scope yet.
    blobs.put({ scope: "temporary", artifactId: artifactId.from("a1") }, BYTES);

    const report = await recover({ recoveryWindowMs: 1_000 });

    expect(availabilityOf(store, "a1")).toBe("reserved");
    expect(blobs.bytesAt({ scope: "temporary", artifactId: artifactId.from("a1") })).not.toBeNull();
    expect(artifactCount(report, "left-for-inspection")).toBe(1);
    expect(blobCount(report, "discarded")).toBe(0);
    await store.close();
  });

  test("is resolved once that process has recorded its end", async () => {
    const { store, blobs, clock, recover } = await harness();
    const live = beginRun({ store, clock, runId: LIVE_RUN });
    if (!live.ok) {
      throw new Error("expected the live run to begin");
    }
    createArtifactRepository(store, LIVE_RUN).reserve(
      reservedArtifact("a1", DIGEST, { byteLength: BYTES.byteLength }),
    );
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);
    live.value.end();

    await recover({ recoveryWindowMs: 1_000 });

    expect(availabilityOf(store, "a1")).toBe("available");
    await store.close();
  });
});

describe("records an earlier run left running", () => {
  test("become uncertain, and never failed", async () => {
    const { store, recover } = await harness();
    insertNonTerminalRecords(store);

    const report = await recover();

    expect(report.markedUncertain).toBe(4);
    const outcomes = store.read(
      `SELECT outcome_kind AS kind, outcome_effect AS effect FROM turns
       UNION ALL SELECT outcome_kind, outcome_effect FROM model_attempts
       UNION ALL SELECT outcome_kind, outcome_effect FROM invocations
       UNION ALL SELECT outcome_kind, outcome_effect FROM sessions`,
    );
    expect(outcomes.ok && outcomes.value).toEqual([
      { kind: "uncertain", effect: "uncertain" },
      { kind: "uncertain", effect: "uncertain" },
      { kind: "uncertain", effect: "uncertain" },
      { kind: "uncertain", effect: "uncertain" },
    ]);
    await store.close();
  });

  test("keep their rows; recovery marks and never deletes", async () => {
    const { store, recover } = await harness();
    insertNonTerminalRecords(store);

    await recover();

    const counted = store.read(
      `SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM turns)
        + (SELECT COUNT(*) FROM model_attempts) + (SELECT COUNT(*) FROM invocations) AS total`,
    );
    expect(counted.ok && counted.value[0]?.total).toBe(4);
    await store.close();
  });

  test("are untouched once they already carry a terminal outcome", async () => {
    const { store, recover } = await harness();
    insertNonTerminalRecords(store);
    await recover();

    const second = await recover();

    expect(second.markedUncertain).toBe(0);
    await store.close();
  });
});

describe("in-flight bytes left behind", () => {
  test("are discarded when the run that owned them ended", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);
    blobs.put({ scope: "temporary", artifactId: artifactId.from("a1") }, BYTES);

    const report = await recover();

    expect(blobs.locations().map((location) => location.scope)).toEqual(["content"]);
    expect(blobCount(report, "discarded")).toBeGreaterThan(0);
    await store.close();
  });

  test("are never removed while the run that owns them has not ended", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, LIVE_RUN, { endedAt: null, startedAt: iso(-86_400_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: LIVE_RUN,
    });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("a1") }, BYTES);

    // A day old, and still not touched: with no liveness probe, age is not
    // evidence that a second Falryn stopped writing.
    const report = await recover({ recoveryWindowMs: 1_000 });

    expect(blobs.bytesAt({ scope: "temporary", artifactId: artifactId.from("a1") })).not.toBeNull();
    expect(blobCount(report, "left-for-inspection")).toBe(1);
    expect(blobCount(report, "discarded")).toBe(0);
    await store.close();
  });

  test("are left alone when nothing attributes them and another run is open", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, LIVE_RUN, { endedAt: null, startedAt: iso(-86_400_000) });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    const report = await recover({ recoveryWindowMs: 1_000 });

    expect(blobs.locations()).toHaveLength(1);
    expect(blobCount(report, "left-for-inspection")).toBe(1);
    await store.close();
  });

  test("are discarded when nothing attributes them and no run is still open", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000), startedAt: iso(-86_400_000) });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    const report = await recover({ recoveryWindowMs: 1_000 });

    // Nothing on this machine is past startup, so nothing can be writing them.
    expect(blobs.locations()).toEqual([]);
    expect(blobCount(report, "discarded")).toBe(1);
    await store.close();
  });

  test("are discarded after this run has written its own row, as composition does", async () => {
    // The order a real start uses: `beginRun` then recover. This run's row is
    // zero milliseconds old at that moment, so a window measured over it could
    // never elapse and this branch would be unreachable in production — which
    // is exactly what every other test here missed by never calling `beginRun`.
    const { store, blobs, clock, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000), startedAt: iso(-86_400_000) });
    const run = beginRun({ store, clock, runId: THIS_RUN });
    expect(run.ok).toBe(true);
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    const report = await recover({ recoveryWindowMs: 60_000 });

    expect(blobs.locations()).toEqual([]);
    expect(blobCount(report, "discarded")).toBe(1);
    await store.close();
  });

  test("are left alone while another run started inside the window", async () => {
    const { store, blobs, clock, recover } = await harness();
    // A peer that started a moment ago and has already ended. It cannot be
    // writing, but a machine cycling processes is where attribution is least
    // reliable, so the sweep stays away.
    insertRun(store, ENDED_RUN, { startedAt: iso(-2_000), endedAt: iso(-1_000) });
    beginRun({ store, clock, runId: THIS_RUN });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    const report = await recover({ recoveryWindowMs: 60_000 });

    expect(blobs.locations()).toHaveLength(1);
    expect(blobCount(report, "left-for-inspection")).toBe(1);
    await store.close();
  });

  test("are left alone inside the recovery window, which covers the startup race", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-1_000), startedAt: iso(-2_000) });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    // A process that has written its run row and has not yet allocated the
    // bytes it is about to write is exactly what the window protects.
    const report = await recover({ recoveryWindowMs: 60_000 });

    expect(blobs.locations()).toHaveLength(1);
    expect(blobCount(report, "left-for-inspection")).toBe(1);
    await store.close();
  });

  test("report a removal a device refused rather than counting it as done", async () => {
    const root = await makeTemporaryRoot("falryn-recovery-fault-");
    const store = await openProductStoreOrThrow(root);
    const blobs = createInMemoryBlobStore({ failOperations: { remove: "permission-denied" } });
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000), startedAt: iso(-86_400_000) });
    blobs.put({ scope: "temporary", artifactId: artifactId.from("orphan") }, BYTES);

    const report = await recoverInterruptedWork({
      store,
      blobs,
      hasher: createSha256Hasher(),
      clock: createManualClock(instant(START)),
      runId: THIS_RUN,
      recoveryWindowMs: 1_000,
    });

    expect(blobCount(report, "failed")).toBe(1);
    expect(report.failed).toBe(1);
    await store.close();
  });
});

describe("a second pass", () => {
  test("changes nothing and reports no repairs", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);
    insertNonTerminalRecords(store);
    await recover();

    const second = await recover();

    expect(second.markedUncertain).toBe(0);
    expect(second.artifactsExamined).toBe(0);
    expect(second.artifacts).toEqual([]);
    expect(second.failed).toBe(0);
    expect(second.effect).toBe("none");
    await store.close();
  });
});

describe("bounds and cancellation", () => {
  test("a cancelled pass reports partial and claims nothing about the rest", async () => {
    const { store, recover } = await harness();
    insertNonTerminalRecords(store);
    const controller = new AbortController();
    controller.abort();

    const report = await recover({ signal: controller.signal });

    expect(report.completeness).toBe("partial");
    expect(report.markedUncertain).toBe(0);
    // Nothing was concluded, so nothing was written.
    expect(availabilityOf(store, "a1")).toBeNull();
    await store.close();
  });
});

describe("the report", () => {
  test("carries the crash signal a pre-open probe found", async () => {
    const { store, recover } = await harness();

    const report = await recover();

    expect(report.crashSignals).toEqual({
      writeAheadLogPresent: false,
      sharedMemoryPresent: false,
    });
    expect(report.runId).toBe(THIS_RUN);
    await store.close();
  });

  test("carries no path, digest, or byte", async () => {
    const { store, blobs, recover } = await harness();
    insertRun(store, ENDED_RUN, { endedAt: iso(-10_000) });
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    const rendered = JSON.stringify(await recover());

    expect(rendered).not.toContain("sha-256:");
    expect(rendered).not.toContain("interrupted content");
    expect(rendered).not.toContain("/");
    await store.close();
  });
});

describe("the run row", () => {
  test("is written at startup with no end time", async () => {
    const { store, clock } = await harness();

    const run = beginRun({ store, clock, runId: THIS_RUN });

    expect(run.ok && run.value.record.endedAt).toBeNull();
    expect(run.ok && run.value.record.schemaVersion).toBe(3);
    const rows = store.read("SELECT ended_at AS endedAt FROM runs WHERE run_id = $id", {
      id: THIS_RUN,
    });
    expect(rows.ok && rows.value[0]?.endedAt).toBeNull();
    await store.close();
  });

  test("refuses a run identity this database already holds", async () => {
    const { store, clock } = await harness();
    beginRun({ store, clock, runId: THIS_RUN });

    const again = beginRun({ store, clock, runId: THIS_RUN });

    expect(again).toMatchObject({ ok: false, error: { code: "already-exists" } });
    await store.close();
  });

  test("is stamped by the shutdown participant, in the phase that persists", async () => {
    const { store, clock } = await harness();
    const run = beginRun({ store, clock, runId: THIS_RUN });
    if (!run.ok) {
      throw new Error("expected the run to begin");
    }

    const participant = createRunShutdownParticipant(run.value);
    expect(participant.phase).toBe("persist-outcomes");
    await participant.run({
      phase: "persist-outcomes",
      signal: new AbortController().signal,
      clock,
    });

    const rows = store.read("SELECT ended_at AS endedAt FROM runs WHERE run_id = $id", {
      id: THIS_RUN,
    });
    expect(rows.ok && rows.value[0]?.endedAt).not.toBeNull();
    await store.close();
  });

  test("stamps its end once, so a second stamp is not a second end", async () => {
    const { store, clock } = await harness();
    const run = beginRun({ store, clock, runId: THIS_RUN });
    if (!run.ok) {
      throw new Error("expected the run to begin");
    }
    run.value.end();
    const first = store.read("SELECT ended_at AS endedAt FROM runs WHERE run_id = $id", {
      id: THIS_RUN,
    });

    clock.advance(duration(5_000));
    run.value.end();

    const second = store.read("SELECT ended_at AS endedAt FROM runs WHERE run_id = $id", {
      id: THIS_RUN,
    });
    expect(second.ok && second.value[0]?.endedAt).toBe(
      (first.ok && first.value[0]?.endedAt) as string,
    );
    await store.close();
  });

  test("makes a run this pass sees as ended stop being presumed live", async () => {
    const { store, blobs, clock, recover } = await harness();
    const run = beginRun({ store, clock, runId: ENDED_RUN });
    if (!run.ok) {
      throw new Error("expected the run to begin");
    }
    insertReserved(store, {
      artifactId: "a1",
      digest: DIGEST,
      byteLength: BYTES.byteLength,
      runId: ENDED_RUN,
    });
    blobs.put({ scope: "content", digest: DIGEST }, BYTES);

    expect((await recover()).artifacts).toEqual([{ outcome: "left-for-inspection", count: 1 }]);
    run.value.end();
    const after = await recover();

    expect(after.artifacts).toEqual([{ outcome: "available", count: 1 }]);
    await store.close();
  });
});

describe("two Falryn processes starting at once", () => {
  test("neither removes the other's in-flight bytes", async () => {
    const { store, blobs, clock, recover } = await harness();
    // Two other processes started and neither has reached its shutdown.
    const first = beginRun({ store, clock, runId: runId.from("run-a") });
    const second = beginRun({ store, clock, runId: runId.from("run-b") });
    expect(first.ok && second.ok).toBe(true);
    // Each has allocated bytes and committed the row that attributes them.
    for (const [id, owner] of [
      ["a1", "run-a"],
      ["a2", "run-b"],
    ] as const) {
      insertReserved(store, {
        artifactId: id,
        digest: DIGEST,
        byteLength: BYTES.byteLength,
        runId: runId.from(owner),
      });
      blobs.put({ scope: "temporary", artifactId: artifactId.from(id) }, BYTES);
    }

    const report = await recover({ recoveryWindowMs: 1_000 });

    // Neither run ended, so both are presumed live and both are left exactly
    // as found — whatever the window says.
    expect(blobs.locations()).toHaveLength(2);
    expect(blobCount(report, "discarded")).toBe(0);
    expect(availabilityOf(store, "a2")).toBe("reserved");
    await store.close();
  });
});

describe("the crash signal probe", () => {
  test("finds the sidecars a clean close removes", async () => {
    const root = await makeTemporaryRoot("falryn-crash-probe-");
    const { createHostFileSystem } = await import("../integrations/index.ts");
    const fileSystem = createHostFileSystem();

    const before = await probeCrashSignals(fileSystem, root);
    // An open database has both; this stages what a killed run leaves behind.
    await Bun.write(`${root}/falryn.sqlite-wal`, "");
    const after = await probeCrashSignals(fileSystem, root);

    expect(before).toEqual({ writeAheadLogPresent: false, sharedMemoryPresent: false });
    expect(after.writeAheadLogPresent).toBe(true);
    expect(after.sharedMemoryPresent).toBe(false);
  });
});
