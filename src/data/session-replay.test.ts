/**
 * Import and effect-free replay against a real migrated database.
 *
 * A package is written through the export path, then applied to a second
 * database that never ran the original work. Replay rebuilds turns from the
 * imported stream and does not name a command runner.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRuntimeRedactor } from "../application/index.ts";
import { sessionStarted } from "../domain/fixtures.ts";
import {
  createInMemoryBlobStore,
  createInMemoryPackageWriter,
  createManualClock,
  EXPORT_FORMAT,
  type ExportName,
  exportName,
  invocationId,
  runId,
  sessionId,
  streamId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createSha256Hasher } from "../integrations/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import { createArtifactStore } from "./artifact-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { resolveInventory, writePackage } from "./export.ts";
import {
  FIXTURE_INSTANT,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { createRecordRepositories } from "./repositories.ts";
import { forkSession, type ImportOptions, importPackage, replaySession } from "./session-replay.ts";

afterEach(removeTemporaryRoots);

const THIS_RUN = runId.from("run-this");
const NAME: ExportName = exportName.from("export-1");
const SESSION = sessionId.from("s1");
const CONTENT = new TextEncoder().encode("exported artifact bytes");

async function openDestination(
  packages: ReturnType<typeof createInMemoryPackageWriter>,
): Promise<ImportOptions & { close(): Promise<void> }> {
  const root = await makeTemporaryRoot("falryn-import-");
  const store = await openProductStoreOrThrow(root);
  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 4)`,
      { runId: THIS_RUN },
    );
  });
  const blobs = createInMemoryBlobStore();
  const repositories = createRecordRepositories(store);
  const events = createSqliteEventStore(store);
  return {
    store,
    repositories,
    events,
    blobs,
    packages,
    hasher: createSha256Hasher(),
    clock: createManualClock(FIXTURE_INSTANT),
    buildIdentity: "falryn/test",
    redactor: createRuntimeRedactor(),
    runId: THIS_RUN,
    async close() {
      await store.close();
    },
  };
}

async function seedExportedPackage(): Promise<{
  store: Awaited<ReturnType<typeof openProductStoreOrThrow>>;
  packages: ReturnType<typeof createInMemoryPackageWriter>;
}> {
  const sourceRoot = await makeTemporaryRoot("falryn-export-src-");
  const store = await openProductStoreOrThrow(sourceRoot);
  const blobs = createInMemoryBlobStore();
  const packages = createInMemoryPackageWriter();
  const repositories = createRecordRepositories(store);
  const events = createSqliteEventStore(store);
  const clock = createManualClock(FIXTURE_INSTANT);
  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 4)`,
      { runId: THIS_RUN },
    );
  });
  repositories.sessions.insert({
    sessionId: SESSION,
    workspaceId: "w" as never,
    streamId: `stream-${SESSION}` as never,
    title: null,
    configurationGeneration: 0 as never,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    closedAt: null,
    outcome: null,
  });
  repositories.turns.insert({
    turnId: turnId.from("t-s1"),
    sessionId: SESSION,
    parentTurnId: null,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
  repositories.invocations.insert({
    invocationId: invocationId.from("inv-1"),
    turnId: turnId.from("t-s1"),
    capabilityId: "read" as never,
    capabilityVersion: 1,
    inputDigest: "ab",
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
  const artifacts = createArtifactStore({
    repository: createArtifactRepository(store, THIS_RUN),
    blobs,
    hasher: createSha256Hasher(),
    clock,
  });
  await artifacts.ingest({
    artifactId: "a1" as never,
    mediaType: "text/plain",
    encoding: "identity",
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: invocationId.from("inv-1"),
    declaredByteLength: CONTENT.byteLength,
    content: (async function* () {
      yield CONTENT;
    })(),
  });
  await events.append({
    ...sessionStarted(1),
    streamId: `stream-${SESSION}` as never,
  });

  const options = {
    store,
    repositories,
    events,
    blobs,
    packages,
    hasher: createSha256Hasher(),
    clock,
    buildIdentity: "falryn/test",
    redactor: createRuntimeRedactor(),
  };
  const inventory = await resolveInventory(options, {
    kind: "sessions",
    sessionIds: [SESSION],
    includeSensitive: false,
  });
  if (!inventory.ok) {
    throw new Error(`expected an inventory: ${inventory.error.code}`);
  }
  const written = await writePackage(
    options,
    NAME,
    {
      kind: "sessions",
      sessionIds: [SESSION],
      includeSensitive: false,
    },
    inventory.value,
  );
  if (!written.ok) {
    throw new Error(`expected a package: ${written.error.code}`);
  }
  return { store, packages };
}

describe("importing a verified package", () => {
  test("replays the imported session without repeating the original work", async () => {
    const { store, packages } = await seedExportedPackage();
    const destination = await openDestination(packages);
    const imported = await importPackage(destination, NAME);
    expect(imported.ok).toBe(true);
    expect(imported.ok && imported.value.sessionIds).toEqual([SESSION]);
    expect(imported.ok && imported.value.artifacts).toBe(1);

    const replayed = await replaySession(destination, SESSION);
    expect(replayed.ok).toBe(true);
    expect(replayed.ok && replayed.value.sessionId).toBe(SESSION);
    expect(replayed.ok && replayed.value.artifacts).toHaveLength(1);
    expect(replayed.ok && replayed.value.truncated).toBe(false);

    const forked = forkSession(destination, SESSION, {
      sessionId: sessionId.from("s2"),
      streamId: streamId.from("stream-s2"),
      workspaceId: workspaceId.from("w2"),
    });
    expect(forked.ok).toBe(true);
    expect(forked.ok && forked.value.sourceSessionId).toBe(SESSION);
    expect(forked.ok && forked.value.sessionId).toBe(sessionId.from("s2"));
    const original = destination.repositories.sessions.get(SESSION);
    expect(original.ok && original.value?.sessionId).toBe(SESSION);

    const again = await importPackage(destination, NAME);
    expect(again.ok).toBe(false);
    expect(again.ok || again.error.code).toBe("identity-collision");

    await store.close();
    await destination.close();
  });

  test("refuses a tampered package before any session is inserted", async () => {
    const { store, packages } = await seedExportedPackage();
    const bytes = packages.bytesOf(NAME);
    if (bytes === null) {
      throw new Error("expected a published package");
    }
    const tampered = new Uint8Array(bytes);
    tampered[EXPORT_FORMAT.length + 5] = (tampered[EXPORT_FORMAT.length + 5] ?? 0) ^ 0xff;
    packages.put(NAME, tampered);

    const destination = await openDestination(packages);
    const imported = await importPackage(destination, NAME);
    expect(imported.ok).toBe(false);
    expect(imported.ok || imported.error.code).toBe("unverified-package");
    const missing = destination.repositories.sessions.get(SESSION);
    expect(missing.ok && missing.value).toBeNull();

    await store.close();
    await destination.close();
  });

  test("reports cancellation instead of applying a package", async () => {
    const { store, packages } = await seedExportedPackage();
    const destination = await openDestination(packages);
    const controller = new AbortController();
    controller.abort();
    const imported = await importPackage(destination, NAME, controller.signal);
    expect(imported.ok).toBe(false);
    expect(imported.ok || imported.error.code).toBe("cancelled");
    const missing = destination.repositories.sessions.get(SESSION);
    expect(missing.ok && missing.value).toBeNull();

    await store.close();
    await destination.close();
  });

  test("refuses to replay a session the destination never imported", async () => {
    const { store, packages } = await seedExportedPackage();
    const destination = await openDestination(packages);
    const replayed = await replaySession(destination, SESSION);
    expect(replayed.ok).toBe(false);
    expect(replayed.ok || replayed.error.code).toBe("record");

    await store.close();
    await destination.close();
  });
});
