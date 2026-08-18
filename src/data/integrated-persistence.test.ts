/**
 * The integrated persistence walk.
 *
 * Every seam below is already proven somewhere — migration and close in
 * `src/main.test.ts`, records in `repositories.test.ts`, ordered appends in
 * `event-store.test.ts`, finalize and committed metadata in
 * `artifact-store.test.ts`, cursors in `projections.test.ts`. What none of them
 * does is walk the chain: a fresh installation that migrates, records a session
 * with its turn, model attempt, invocation, and ordered events, finalizes an
 * artifact through the declared boundary, advances a projection cursor, then
 * closes and reads all of it back at one source revision.
 *
 * Three things make this the integration proof rather than a sixth unit file:
 *
 * - **Every owner is the real one.** The store, the typed repositories, the
 *   durable event store, the artifact store over the host blob adapter and the
 *   real SHA-256 hasher, and the projection runner, against a temporary state
 *   root. A double anywhere would put the gap back.
 * - **The walk is one test.** Splitting it into a test per step recreates
 *   exactly the per-seam inference it exists to replace, so its length is the
 *   point rather than an accident.
 * - **The read-back asserts every entity the criterion names**, so removing any
 *   one seam fails it. A scenario that only checked the last step would pass
 *   over a broken middle.
 *
 * The restart is a close and a second open against the same root, which is what
 * lets the scenario assert state on both sides of the boundary. A restart of the
 * compiled *process* is a different criterion and `src/main.compiled.test.ts`
 * already covers it.
 *
 * Mirrors `src/application/integrated-lifecycle.test.ts`: same naming, same
 * purpose, one area down.
 */

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { createArtifactViewer } from "../application/artifact-view.ts";
import {
  everyEventKind,
  invocationRecord,
  modelAttemptRecord,
  sessionRecord,
  turnRecord,
} from "../domain/fixtures.ts";
import {
  ARTIFACT_API_VERSION,
  type ArtifactProvenancePort,
  type ArtifactRepositoryPort,
  type ArtifactStorePort,
  artifactId,
  type BlobStorePort,
  type ClockPort,
  createManualClock,
  type EventStorePort,
  type LocalPath,
  localPath,
  type ProjectionCursor,
  type RecordRepositories,
  type RunId,
  runId as runIdCodec,
  type SessionView,
  type SqliteStorePort,
  sequence,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  type Timestamp,
} from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher } from "../integrations/index.ts";
import { createArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import { createArtifactStore, type DurableArtifactStore } from "./artifact-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import {
  FIXTURE_INSTANT,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { createProjectionRunner, type ProjectionRunner } from "./projections.ts";
import { beginRun } from "./recovery.ts";
import { createRecordRepositories, readSessionView } from "./repositories.ts";
import { PRODUCT_SCHEMA_VERSION, PRODUCTION_MIGRATIONS } from "./sqlite-migrations.ts";

afterEach(removeTemporaryRoots);

const ARTIFACT = artifactId.from("artifact-integrated");
const CHILD = artifactId.from("artifact-integrated-child");
const CONTENT = new TextEncoder().encode("the bytes one invocation produced");
const DERIVED = new TextEncoder().encode("bytes derived from that invocation");

/**
 * Everything one process composes over one open database.
 *
 * Assembled the way `src/main.ts` assembles it — the same constructors in the
 * same order over the same roots — so a restart here composes a second process's
 * worth of owners rather than reusing the first's.
 */
type Process = {
  readonly store: SqliteStorePort;
  readonly repositories: RecordRepositories;
  readonly events: EventStorePort;
  readonly artifacts: DurableArtifactStore;
  readonly artifactRecords: ArtifactRepositoryPort;
  readonly provenance: ArtifactProvenancePort;
  readonly projections: ProjectionRunner;
};

function blobStoreIn(root: LocalPath): BlobStorePort {
  // The adapter creates what it needs when it needs it, so neither directory is
  // prepared here — the same reason `src/main.ts` prepares only `state`.
  return createHostBlobStore({
    artifactsRoot: localPath(join(root, "artifacts")),
    temporaryRoot: localPath(join(root, "ingest")),
  });
}

async function open(root: LocalPath, id: string): Promise<Process> {
  const store = await openProductStoreOrThrow(root);
  const clock: ClockPort = createManualClock(FIXTURE_INSTANT);

  // This run's row, before anything else reads or writes, so ingested bytes
  // carry the attribution a later recovery pass depends on.
  const run = beginRun({ store, clock, runId: runIdCodec.from(id) });
  if (!run.ok) {
    throw new Error(`expected the run to be recorded: ${run.error.code}`);
  }
  const attributedTo: RunId = run.value.record.runId;

  const events = createSqliteEventStore(store);
  const artifactRecords = createArtifactRepository(store, attributedTo);

  return {
    store,
    repositories: createRecordRepositories(store),
    events,
    artifactRecords,
    provenance: createArtifactProvenanceRepository(store),
    artifacts: createArtifactStore({
      repository: artifactRecords,
      blobs: blobStoreIn(root),
      hasher: createSha256Hasher(),
      clock,
    }),
    projections: createProjectionRunner({ store, events, clock }),
  };
}

async function* oneChunk(): AsyncGenerator<Uint8Array> {
  yield CONTENT;
}

function cursorOf(process: Process): ProjectionCursor | null {
  const cursor = process.projections.readCursor(sessionRecord().streamId);
  if (!cursor.ok) {
    throw new Error(`expected a readable cursor: ${cursor.error.code}`);
  }
  return cursor.value;
}

async function viewOf(process: Process): Promise<SessionView> {
  const view = await readSessionView(
    process.repositories,
    process.events,
    sessionRecord().sessionId,
  );
  if (!view.ok) {
    throw new Error(`expected a session view: ${view.error.code}`);
  }
  if (view.value === null) {
    throw new Error("the session did not survive the restart");
  }
  return view.value;
}

test("walks a fresh installation through every durable seam and reads it back after a restart", async () => {
  const root = await makeTemporaryRoot("falryn-integrated-persistence-");

  // ── A fresh installation migrates to the current schema and opens ──────────
  const first = await open(root, "run-first");

  expect(first.store.report.created).toBe(true);
  expect(first.store.report.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);
  expect(first.store.report.appliedThisRun).toEqual(
    PRODUCTION_MIGRATIONS.map((migration) => migration.version),
  );

  // ── It records a session, turn, model attempt, and invocation ──────────────
  expect(first.repositories.sessions.insert(sessionRecord()).ok).toBe(true);
  expect(first.repositories.turns.insert(turnRecord()).ok).toBe(true);
  expect(first.repositories.modelAttempts.insert(modelAttemptRecord()).ok).toBe(true);
  expect(first.repositories.invocations.insert(invocationRecord()).ok).toBe(true);

  // ── and their ordered events ──────────────────────────────────────────────
  const appended = everyEventKind();
  for (const event of appended) {
    const write = await first.events.append(event);
    expect(write.ok && write.value.kind).toBe("appended");
    expect(write.ok && write.value.sequence).toBe(event.sequence);
  }

  // ── It finalizes an artifact and commits its metadata in the declared
  //    boundary. Through `ingest`, never a direct row insert: a direct insert
  //    would prove the table exists and nothing about the boundary. ───────────
  const ingested = await first.artifacts.ingest({
    artifactId: ARTIFACT,
    mediaType: "text/plain",
    encoding: "identity",
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: invocationRecord().invocationId,
    declaredByteLength: CONTENT.byteLength,
    content: oneChunk(),
  });
  expect(ingested.ok && ingested.value.record.availability).toBe("available");
  expect(ingested.ok && ingested.value.record.finalizedAt).not.toBeNull();
  const digest = ingested.ok ? ingested.value.record.digest : null;
  expect(digest).not.toBeNull();

  const derived = await first.artifacts.ingest({
    artifactId: CHILD,
    mediaType: "text/plain",
    encoding: "identity",
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: invocationRecord().invocationId,
    declaredByteLength: DERIVED.byteLength,
    content: (async function* () {
      yield DERIVED;
    })(),
  });
  expect(derived.ok && derived.value.record.availability).toBe("available");
  const linked = first.provenance.insert({
    schemaVersion: ARTIFACT_API_VERSION,
    childArtifactId: CHILD,
    parentArtifactId: ARTIFACT,
    transformation: "derived-from",
    createdAt: "2026-07-31T12:00:00.000Z" as Timestamp,
  });
  expect(linked.ok).toBe(true);

  // ── It advances a projection cursor ───────────────────────────────────────
  const advanced = await first.projections.advance(sessionRecord().streamId);
  expect(advanced.ok && advanced.value).toMatchObject({
    streamId: sessionRecord().streamId,
    eventsRead: appended.length,
    unmatched: 0,
    lastAppliedSequence: sequence.from(appended.length),
    stopped: false,
  });
  expect(cursorOf(first)?.lastAppliedSequence).toBe(sequence.from(appended.length));

  // ── The restart ───────────────────────────────────────────────────────────
  const closed = await first.store.close();
  expect(closed.closed).toBe(true);
  expect(first.store.isClosed()).toBe(true);

  const second = await open(root, "run-second");

  // The same database, not a second one: nothing was created and no migration
  // ran, which is what makes everything below a read of durable state rather
  // than of state this process just rebuilt.
  expect(second.store.report.created).toBe(false);
  expect(second.store.report.appliedThisRun).toEqual([]);
  expect(second.store.report.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);

  // ── and reads all of it back ──────────────────────────────────────────────
  const view = await viewOf(second);

  expect(view.session).toEqual(
    // The projection derives a session's *turn* outcomes, not the session's own,
    // so the session row is unchanged from what was written.
    sessionRecord(),
  );
  expect(view.truncated).toBe(false);

  expect(view.turns).toHaveLength(1);
  const turn = view.turns[0];
  expect(turn?.turn.turnId).toBe(turnRecord().turnId);
  expect(turn?.modelAttempts.map((attempt) => attempt.modelAttemptId)).toEqual([
    modelAttemptRecord().modelAttemptId,
  ]);
  expect(turn?.invocations.map((invocation) => invocation.invocationId)).toEqual([
    invocationRecord().invocationId,
  ]);

  // Order, not membership. The criterion says *ordered* events, and a set
  // comparison would accept a stream that replayed backwards.
  expect(view.events.map((event) => event.sequence)).toEqual(
    appended.map((event) => event.sequence),
  );
  expect(view.events.map((event) => event.kind)).toEqual(appended.map((event) => event.kind));
  expect(view.events.map((event) => event.eventId)).toEqual(appended.map((event) => event.eventId));

  // The artifact's metadata, read through the repository the store committed it
  // with, and its bytes, read back through the same blob adapter.
  const record = second.artifactRecords.get(ARTIFACT);
  expect(record.ok && record.value).toMatchObject({
    artifactId: ARTIFACT,
    digest,
    byteLength: CONTENT.byteLength,
    availability: "available",
    invocationId: invocationRecord().invocationId,
  });
  expect(record.ok && record.value?.finalizedAt).not.toBeNull();

  const stored: ArtifactStorePort = second.artifacts;
  const range = await stored.readRange(ARTIFACT, 0, CONTENT.byteLength);
  expect(range.ok && range.value.bytes).toEqual(CONTENT);
  expect(range.ok && range.value.endOfArtifact).toBe(true);

  const lineage = second.provenance.listParents(CHILD);
  expect(lineage.ok && lineage.value).toEqual([
    {
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: CHILD,
      parentArtifactId: ARTIFACT,
      transformation: "derived-from",
      createdAt: "2026-07-31T12:00:00.000Z" as Timestamp,
    },
  ]);
  const intact = await second.artifacts.verifyIntegrity(ARTIFACT);
  expect(intact.ok && intact.value).toBe(true);

  const viewed = await createArtifactViewer(second.artifacts).view({
    artifactId: ARTIFACT,
  });
  expect(viewed.ok && viewed.value.status).toBe("complete");
  expect(viewed.ok && viewed.value.kind).toBe("document");
  expect(viewed.ok && viewed.value.body).toMatchObject({
    kind: "document",
    family: "text",
    text: "the bytes one invocation produced",
  });

  // The cursor, and the state it claims to describe. Asserted against the
  // events actually committed rather than merely as non-null.
  expect(cursorOf(second)).toMatchObject({
    projection: "terminal-outcomes",
    streamId: sessionRecord().streamId,
    lastAppliedSequence: sequence.from(appended.length),
    schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
  });
  expect(turn?.turn.outcome).toEqual({ kind: "completed" });
  expect(turn?.modelAttempts[0]?.outcome).toEqual({ kind: "failed", effect: "none" });
  expect(turn?.invocations[0]?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });

  await second.store.close();
});
