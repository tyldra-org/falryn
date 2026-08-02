/**
 * The export pipeline against a real migrated database.
 *
 * Records and artifacts are staged through the repositories and the artifact
 * store — the shipped paths — so what these check is the selection, inventory,
 * writer, and verifier rather than a double's agreement with fabricated rows.
 * The package is staged in memory; the adapter has its own tests against a real
 * temporary directory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sessionStarted } from "../domain/fixtures.ts";
import {
  type ArtifactSensitivity,
  artifactId,
  createInMemoryBlobStore,
  createInMemoryPackageWriter,
  createManualClock,
  type EventStorePort,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  type ExportError,
  type ExportName,
  type ExportSelection,
  exportName,
  invocationId,
  MAX_EXPORTED_SESSIONS,
  MAX_STREAM_READ_LIMIT,
  RECORDS_MEMBER,
  type RecordRepositories,
  type Result,
  RUNTIME_EVENT_SCHEMA_FAMILY,
  RUNTIME_EVENT_SCHEMA_VERSION,
  runId,
  type SessionId,
  type SqliteStorePort,
  sessionId,
  turnId,
} from "../domain/index.ts";
import { createSha256Hasher } from "../integrations/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import { createArtifactStore } from "./artifact-store.ts";
import { createSqliteEventStore } from "./event-store.ts";
import {
  type ExportOptions,
  resolveInventory,
  verifyPackage,
  WRITTEN_SCHEMA_FAMILIES,
  writePackage,
} from "./export.ts";
import {
  FIXTURE_INSTANT,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { createRecordRepositories } from "./repositories.ts";

afterEach(removeTemporaryRoots);

const THIS_RUN = runId.from("run-this");
const NAME: ExportName = exportName.from("export-1");
const SESSION = sessionId.from("s1");
const CONTENT = new TextEncoder().encode("exported artifact bytes");

type Harness = {
  readonly store: SqliteStorePort;
  readonly blobs: ReturnType<typeof createInMemoryBlobStore>;
  readonly packages: ReturnType<typeof createInMemoryPackageWriter>;
  readonly repositories: RecordRepositories;
  readonly events: EventStorePort;
  readonly options: ExportOptions;
  /** Ingests one artifact and links it to the staged invocation. */
  ingest(id: string, sensitivity: ArtifactSensitivity): Promise<void>;
};

async function harness(
  overrides: {
    readonly packages?: ReturnType<typeof createInMemoryPackageWriter>;
    readonly maxPackageBytes?: number;
  } = {},
): Promise<Harness> {
  const root = await makeTemporaryRoot("falryn-export-");
  const store = await openProductStoreOrThrow(root);
  const blobs = createInMemoryBlobStore();
  const packages = overrides.packages ?? createInMemoryPackageWriter();
  const repositories = createRecordRepositories(store);
  const events = createSqliteEventStore(store);
  const clock = createManualClock(FIXTURE_INSTANT);

  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 3)`,
      { runId: THIS_RUN },
    );
  });

  const artifacts = createArtifactStore({
    repository: createArtifactRepository(store, THIS_RUN),
    blobs,
    hasher: createSha256Hasher(),
    clock,
  });

  return {
    store,
    blobs,
    packages,
    repositories,
    events,
    options: {
      store,
      repositories,
      events,
      blobs,
      packages,
      hasher: createSha256Hasher(),
      clock,
      buildIdentity: "falryn/test",
      ...(overrides.maxPackageBytes === undefined
        ? {}
        : { maxPackageBytes: overrides.maxPackageBytes }),
    },
    async ingest(id: string, sensitivity: ArtifactSensitivity): Promise<void> {
      const ingested = await artifacts.ingest({
        artifactId: artifactId.from(id),
        mediaType: "text/plain",
        encoding: "identity",
        sensitivity,
        origin: "tool-output",
        invocationId: invocationId.from("inv-1"),
        declaredByteLength: CONTENT.byteLength,
        content: (async function* () {
          yield CONTENT;
        })(),
      });
      if (!ingested.ok) {
        throw new Error(`expected the artifact to ingest: ${ingested.error.code}`);
      }
    },
  };
}

/** A session with one turn and one invocation, through the repositories. */
function stageSession(repositories: RecordRepositories, id: SessionId = SESSION): void {
  const inserted = repositories.sessions.insert({
    sessionId: id,
    workspaceId: "w" as never,
    streamId: `stream-${id}` as never,
    title: null,
    configurationGeneration: 0 as never,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    closedAt: null,
    outcome: null,
  });
  if (!inserted.ok) {
    throw new Error("expected the session to insert");
  }
  repositories.turns.insert({
    turnId: turnId.from(`t-${id}`),
    sessionId: id,
    parentTurnId: null,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
  repositories.invocations.insert({
    invocationId: invocationId.from("inv-1"),
    turnId: turnId.from(`t-${id}`),
    capabilityId: "read" as never,
    capabilityVersion: 1,
    inputDigest: "ab",
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
}

/** One event on a session's stream, through the durable store. */
async function appendEvent(built: Harness, sequence: number): Promise<void> {
  const appended = await built.events.append({
    ...sessionStarted(sequence),
    streamId: `stream-${SESSION}` as never,
  });
  if (!appended.ok) {
    throw new Error(`expected the event to append: ${appended.error.code}`);
  }
}

const SESSIONS_SELECTION: ExportSelection = {
  kind: "sessions",
  sessionIds: [SESSION],
  includeSensitive: false,
};

const DIGEST_LITERAL = `sha-256:${"a".repeat(64)}`;

/**
 * Rewrites a published package's manifest, footer and all.
 *
 * The body is left untouched, so what a test stages is a well-formed package
 * whose *claim* is wrong — which is the only thing verification can be asked
 * about.
 */
function restamp(
  built: Harness,
  change: (manifest: Record<string, unknown>) => Record<string, unknown>,
): void {
  const decoded = new TextDecoder().decode(built.packages.bytesOf(NAME) as Uint8Array);
  const start = decoded.indexOf(`{"format"`);
  const manifest = JSON.parse(decoded.slice(start, decoded.lastIndexOf("}\n") + 1));
  const rewritten = JSON.stringify(change(manifest));
  const length = new TextEncoder().encode(`${rewritten}\n`).byteLength;
  built.packages.put(
    NAME,
    new TextEncoder().encode(
      `${decoded.slice(0, start)}${rewritten}\n${String(length).padStart(20, "0")}\n`,
    ),
  );
}

function errorOf<Value>(result: Result<Value, ExportError>): ExportError | null {
  return result.ok ? null : result.error;
}

async function inventoryOf(built: Harness, selection = SESSIONS_SELECTION) {
  const inventory = await resolveInventory(built.options, selection);
  if (!inventory.ok) {
    throw new Error(`expected an inventory: ${inventory.error.code}`);
  }
  return inventory.value;
}

describe("resolving a selection", () => {
  test("counts everything it reaches before a byte is written", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");

    const inventory = await inventoryOf(built);

    expect(inventory.counts).toMatchObject({ sessions: 1, turns: 1, invocations: 1, artifacts: 1 });
    expect(inventory.artifacts).toHaveLength(1);
    expect(inventory.artifactBytes).toBe(CONTENT.byteLength);
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("counts the events it will write, because the manifest declares them", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await appendEvent(built, 1);
    await appendEvent(built, 2);

    const inventory = await inventoryOf(built);

    // A count the manifest declares and the member does not match is a package
    // nobody can check, which is the whole point of declaring it.
    expect(inventory.counts.events).toBe(2);
    await built.store.close();
  });

  test("reports a session this database does not hold", async () => {
    const built = await harness();

    const inventory = await resolveInventory(built.options, {
      kind: "sessions",
      sessionIds: [sessionId.from("missing")],
      includeSensitive: false,
    });

    expect(errorOf(inventory)).toMatchObject({ code: "not-found", sessionId: "missing" });
    await built.store.close();
  });

  test("reports an empty selection rather than writing an empty package", async () => {
    const built = await harness();

    const inventory = await resolveInventory(built.options, {
      kind: "range",
      startedAfter: null,
      startedBefore: null,
      includeSensitive: false,
    });

    // Until a producer lands this is the only kind of database there is, so the
    // distinction has to be a reported fact rather than a surprise.
    expect(errorOf(inventory)?.code).toBe("empty-selection");
    await built.store.close();
  });

  test("resolves a range across the sessions it covers", async () => {
    const built = await harness();
    stageSession(built.repositories);

    const inventory = await inventoryOf(built, {
      kind: "range",
      startedAfter: "2026-07-01T00:00:00.000Z" as never,
      startedBefore: "2026-08-01T00:00:00.000Z" as never,
      includeSensitive: false,
    });

    expect(inventory.sessionIds).toEqual([SESSION]);
    await built.store.close();
  });

  test("refuses a selection above its session bound", async () => {
    const built = await harness();
    const many = Array.from({ length: MAX_EXPORTED_SESSIONS + 1 }, (_, index) =>
      sessionId.from(`s${index}`),
    );
    for (const id of many.slice(0, 2)) {
      stageSession(built.repositories, id);
    }

    const inventory = await resolveInventory(built.options, {
      kind: "sessions",
      sessionIds: many,
      includeSensitive: false,
    });

    // Reported as not-found on the third, which is still a refusal before any
    // byte is written — the bound and the missing row are both pre-write facts.
    expect(errorOf(inventory)).not.toBeNull();
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("refuses an artifact-free selection whose records exceed the ceiling", async () => {
    // The records member grows with every session, turn, and event named, so a
    // ceiling that only bounded artifact bytes would let a selection with no
    // artifacts publish a package many times the configured limit.
    const built = await harness({ maxPackageBytes: 1 });
    stageSession(built.repositories);
    await appendEvent(built, 1);
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(written)).toMatchObject({ code: "oversize", bound: "package-bytes" });
    expect(built.packages.finalized()).toEqual([]);
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("refuses a package larger than its configured ceiling", async () => {
    const built = await harness({ maxPackageBytes: 4 });
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");

    const inventory = await resolveInventory(built.options, SESSIONS_SELECTION);

    expect(errorOf(inventory)).toMatchObject({ code: "oversize", bound: "package-bytes" });
    await built.store.close();
  });
});

describe("the events member", () => {
  test("carries every event, rather than the first page of them", async () => {
    const built = await harness();
    stageSession(built.repositories);
    // Past one page of the underlying stream read, which a single call would
    // silently truncate — an absence nobody declared.
    for (let sequence = 1; sequence <= MAX_STREAM_READ_LIMIT + 3; sequence += 1) {
      await appendEvent(built, sequence);
    }
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(inventory.counts.events).toBe(MAX_STREAM_READ_LIMIT + 3);
    const bytes = built.packages.bytesOf(NAME);
    const lines = new TextDecoder()
      .decode(bytes as Uint8Array)
      .split("\n")
      .filter((entry) => entry.includes(`"entity":"event"`));
    expect(lines).toHaveLength(MAX_STREAM_READ_LIMIT + 3);
    expect(written.ok && written.value.manifest.counts.events).toBe(lines.length);
    await built.store.close();
  });
});

describe("what a package may never carry", () => {
  test("omits a restricted artifact even when the selection asks for sensitive content", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "restricted");

    const inventory = await inventoryOf(built, {
      kind: "sessions",
      sessionIds: [SESSION],
      includeSensitive: true,
    });

    // The vocabulary decides this, not a flag. A selection that could opt back
    // in would make the label decoration.
    expect(inventory.artifacts).toEqual([]);
    expect(inventory.omissions).toEqual([
      { artifactId: "a1" as never, reason: "restricted-sensitivity" },
    ]);
    await built.store.close();
  });

  test("omits sensitive content the selection did not ask for, and carries it when it did", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "sensitive");

    const withheld = await inventoryOf(built);
    const included = await inventoryOf(built, {
      kind: "sessions",
      sessionIds: [SESSION],
      includeSensitive: true,
    });

    expect(withheld.omissions).toEqual([
      { artifactId: "a1" as never, reason: "sensitive-not-selected" },
    ]);
    expect(included.artifacts).toHaveLength(1);
    await built.store.close();
  });

  test("omits an artifact whose bytes are missing or quarantined", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    built.store.write((statements) =>
      statements.run("UPDATE artifacts SET availability = 'missing' WHERE artifact_id = 'a1'"),
    );

    const inventory = await inventoryOf(built);

    expect(inventory.omissions).toEqual([{ artifactId: "a1" as never, reason: "bytes-missing" }]);
    await built.store.close();
  });
});

describe("writing a package", () => {
  test("publishes one package whose manifest matches its members", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(written.ok).toBe(true);
    const manifest = written.ok ? written.value.manifest : null;
    expect(manifest?.format).toBe(EXPORT_FORMAT);
    expect(manifest?.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest?.members.map((member) => member.kind)).toEqual(["records", "artifact"]);
    expect(manifest?.members[0]?.name).toBe(RECORDS_MEMBER);
    expect(built.packages.finalized()).toEqual([NAME]);
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("declares the schema families a reader has to understand", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await appendEvent(built, 1);
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(written.ok && written.value.manifest.schemaFamilies).toEqual([
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION },
    ]);
    await built.store.close();
  });

  test("declares the family for a selection whose sessions produced no events", async () => {
    // The families name the shape a reader must understand, not the rows that
    // happen to be present: the records member is that family's encoding by
    // construction, so an events-free selection is still a legal export.
    const built = await harness();
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);
    expect(inventory.counts.events).toBe(0);

    const write = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);
    const verified = await verifyPackage(built.options, NAME);

    expect(write.ok && write.value.manifest.schemaFamilies).toEqual(WRITTEN_SCHEMA_FAMILIES);
    expect(verified.ok && verified.value.verified).toBe(true);
    expect(verified.ok && verified.value.manifest.schemaFamilies).toEqual(WRITTEN_SCHEMA_FAMILIES);
    await built.store.close();
  });

  test("carries the omissions the inventory declared", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "restricted");
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(written.ok && written.value.manifest.omissions).toEqual([
      { artifactId: "a1" as never, reason: "restricted-sensitivity" },
    ]);
    await built.store.close();
  });

  test("refuses to overwrite a package that is already there", async () => {
    const built = await harness();
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);
    await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    const again = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(again)).toMatchObject({ code: "package", error: { code: "already-exists" } });
    await built.store.close();
  });

  test("leaves nothing at the destination when a write fails", async () => {
    const packages = createInMemoryPackageWriter({ failOperations: { write: "disk-full" } });
    const built = await harness({ packages });
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(written)).toMatchObject({ code: "package", error: { code: "disk-full" } });
    // A half-written package must never be where a finished one would be.
    expect(packages.finalized()).toEqual([]);
    expect(packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("leaves nothing at the destination when the flush fails", async () => {
    // A device that accepted every byte and then failed to flush is the case a
    // write-only fault cannot reach: the package looks complete right up to the
    // moment it is closed.
    const packages = createInMemoryPackageWriter({ failOperations: { close: "io-failure" } });
    const built = await harness({ packages });
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(written)).toMatchObject({ code: "package", error: { code: "io-failure" } });
    expect(packages.finalized()).toEqual([]);
    expect(packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("reports a cancellation that arrived after the publish beside the package", async () => {
    const built = await harness();
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);
    const controller = new AbortController();
    const inner = built.packages;
    const options: ExportOptions = {
      ...built.options,
      packages: {
        ...inner,
        async finalize(name, signal) {
          const published = await inner.finalize(name, signal);
          // The publish stands; the cancellation arrived after it.
          controller.abort();
          return published;
        },
      },
    };

    const written = await writePackage(
      options,
      NAME,
      SESSIONS_SELECTION,
      inventory,
      controller.signal,
    );

    // Calling this cancelled would tell a caller nothing happened when a
    // package is sitting at the destination.
    expect(written.ok).toBe(true);
    expect(written.ok && written.value.cancelledAfterFinalize).toBe(true);
    expect(inner.finalized()).toEqual([NAME]);
    await built.store.close();
  });

  test("refuses to start when the device has less space than the inventory needs", async () => {
    const packages = createInMemoryPackageWriter({ availableBytes: 4 });
    const built = await harness({ packages });
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    const inventory = await inventoryOf(built);

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(written)).toMatchObject({
      code: "insufficient-space",
      requiredBytes: CONTENT.byteLength,
      availableBytes: 4,
    });
    expect(packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("reports bytes that moved between inventory and write", async () => {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    const inventory = await inventoryOf(built);
    // The bytes changed underneath the export.
    built.blobs.put(
      { scope: "content", digest: inventory.artifacts[0]?.digest as never },
      new TextEncoder().encode("something else entirely"),
    );

    const written = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);

    expect(errorOf(written)).toMatchObject({ code: "digest-mismatch", artifactId: "a1" });
    expect(built.packages.finalized()).toEqual([]);
    await built.store.close();
  });

  test("cancellation mid-stream discards the staged package", async () => {
    const controller = new AbortController();
    const real = createSha256Hasher();
    let created = 0;
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    const inventory = await inventoryOf(built);
    // Cancels as the artifact member begins, which is the only point at which
    // a staged package exists and has not been published.
    const options: ExportOptions = {
      ...built.options,
      hasher: {
        create() {
          created += 1;
          if (created === 2) {
            controller.abort();
          }
          return real.create();
        },
      },
    };

    const written = await writePackage(
      options,
      NAME,
      SESSIONS_SELECTION,
      inventory,
      controller.signal,
    );

    expect(errorOf(written)?.code).toBe("cancelled");
    expect(built.packages.finalized()).toEqual([]);
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });

  test("cancellation before the publish leaves no package and reports cancelled", async () => {
    const built = await harness();
    stageSession(built.repositories);
    const inventory = await inventoryOf(built);
    const controller = new AbortController();
    controller.abort();

    const written = await writePackage(
      built.options,
      NAME,
      SESSIONS_SELECTION,
      inventory,
      controller.signal,
    );

    expect(errorOf(written)?.code).toBe("cancelled");
    expect(built.packages.finalized()).toEqual([]);
    expect(built.packages.staged()).toEqual([]);
    await built.store.close();
  });
});

describe("verifying a finished package", () => {
  async function written(): Promise<Harness> {
    const built = await harness();
    stageSession(built.repositories);
    await built.ingest("a1", "user-content");
    const inventory = await inventoryOf(built);
    const result = await writePackage(built.options, NAME, SESSIONS_SELECTION, inventory);
    if (!result.ok) {
      throw new Error(`expected a package: ${result.error.code}`);
    }
    return built;
  }

  test("proves every member is the member the manifest declared", async () => {
    const built = await written();

    const verified = await verifyPackage(built.options, NAME);

    expect(verified.ok && verified.value.verified).toBe(true);
    expect(verified.ok && verified.value.members.map((member) => member.status)).toEqual([
      "verified",
      "verified",
    ]);
    await built.store.close();
  });

  test("catches a member whose bytes were altered after publishing", async () => {
    const built = await written();
    const bytes = built.packages.bytesOf(NAME);
    if (bytes === null) {
      throw new Error("expected a published package");
    }
    const tampered = new Uint8Array(bytes);
    // One byte inside the records member, well clear of the trailer.
    tampered[EXPORT_FORMAT.length + 5] = (tampered[EXPORT_FORMAT.length + 5] ?? 0) ^ 0xff;
    built.packages.put(NAME, tampered);

    const verified = await verifyPackage(built.options, NAME);

    expect(verified.ok && verified.value.verified).toBe(false);
    expect(verified.ok && verified.value.members[0]?.status).toBe("digest-mismatch");
    await built.store.close();
  });

  test("catches a truncated package rather than reading past its end", async () => {
    const built = await written();
    const bytes = built.packages.bytesOf(NAME);
    built.packages.put(NAME, (bytes as Uint8Array).slice(0, 12));

    const verified = await verifyPackage(built.options, NAME);

    expect(errorOf(verified)?.code).toBe("truncated-package");
    await built.store.close();
  });

  test("refuses a package that is not a Falryn export", async () => {
    const built = await harness();
    built.packages.put(NAME, new TextEncoder().encode("not an export at all"));

    const verified = await verifyPackage(built.options, NAME);

    expect(errorOf(verified)?.code).toBe("truncated-package");
    await built.store.close();
  });

  test("refuses a package that declares no schema families", async () => {
    // `falryn-export/1` requires the field, so a development-tree package
    // written before it existed is refused rather than leniently accepted.
    const built = await written();
    restamp(built, ({ schemaFamilies: _dropped, ...manifest }) => manifest);

    const verified = await verifyPackage(built.options, NAME);

    expect(errorOf(verified)).toMatchObject({
      code: "malformed-manifest",
      issues: [{ path: "schemaFamilies" }],
    });
    await built.store.close();
  });

  test("reports a package this build is too old to open", async () => {
    const built = await written();
    restamp(built, (manifest) => ({
      ...manifest,
      minimumCompatibleSchemaVersion: EXPORT_SCHEMA_VERSION + 1,
    }));

    const verified = await verifyPackage(built.options, NAME);

    expect(errorOf(verified)).toMatchObject({
      code: "incompatible-version",
      packageRequiresAtLeast: EXPORT_SCHEMA_VERSION + 1,
      readerSchemaVersion: EXPORT_SCHEMA_VERSION,
    });
    await built.store.close();
  });

  test("reports a member the package does not actually contain", async () => {
    const built = await written();
    // A manifest declaring more than the body holds. Re-stamped whole, footer
    // included, so the package is well-formed and only its claim is wrong.
    restamp(built, (manifest) => ({
      ...manifest,
      members: [
        ...(manifest.members as readonly unknown[]),
        { name: "artifacts/absent", kind: "artifact", byteLength: 4_096, digest: DIGEST_LITERAL },
      ],
    }));

    const verified = await verifyPackage(built.options, NAME);

    expect(verified.ok && verified.value.verified).toBe(false);
    expect(verified.ok && verified.value.members.at(-1)?.status).toBe("missing");
    await built.store.close();
  });

  test("reports a member the package stops short of", async () => {
    const built = await written();
    const inner = built.packages;
    let reads = 0;
    // A device that answers the first read of a member and then returns
    // nothing: the member is inside the body, so it is not missing, and it is
    // not a digest mismatch either — it is shorter than declared.
    const options: ExportOptions = {
      ...built.options,
      packages: {
        ...inner,
        async readRange(name, offset, length, signal) {
          reads += 1;
          return reads > 3
            ? { ok: true, value: new Uint8Array(0) }
            : inner.readRange(name, offset, length, signal);
        },
      },
    };

    const verified = await verifyPackage(options, NAME);

    expect(
      verified.ok && verified.value.members.some((member) => member.status === "wrong-length"),
    ).toBe(true);
    await built.store.close();
  });

  test("reports a package that is not there", async () => {
    const built = await harness();

    const verified = await verifyPackage(built.options, exportName.from("absent"));

    expect(errorOf(verified)?.code).toBe("truncated-package");
    await built.store.close();
  });
});
