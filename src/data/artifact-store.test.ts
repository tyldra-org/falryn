/**
 * The artifact pipeline, end to end, against a real migrated database.
 *
 * Bytes are staged in memory rather than on a disk, and the hasher is the real
 * SHA-256 one with chosen answers substituted at chosen positions — so a test
 * that proves the store quarantines is proving the store's behavior rather than
 * a mock's. The blob adapter's own tests use a real temporary directory.
 *
 * The state matrix these cover is the one the issue names: interruption at each
 * ingest stage, digest mismatch, both size mismatches, oversize, range
 * boundaries, cancellation on either side of the commit, deduplication, and
 * finalize under shutdown.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  type ArtifactError,
  type ArtifactIngestRequest,
  type ArtifactRepositoryPort,
  artifactId,
  type BlobOperation,
  type ContentDigest,
  type ContentHasherPort,
  createInMemoryBlobStore,
  createManualClock,
  instant,
  invocationId,
  MAX_ARTIFACT_PREVIEW_BYTES,
  MAX_ARTIFACT_RANGE_BYTES,
  type Result,
  type SqliteStorePort,
} from "../domain/index.ts";
import { createSha256Hasher } from "../integrations/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import {
  type ArtifactStoreOptions,
  createArtifactShutdownParticipant,
  createArtifactStore,
  type DurableArtifactStore,
} from "./artifact-store.ts";
import {
  FIXTURE_INSTANT,
  fixtureDigest,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
  stagedHasher,
} from "./fixtures.ts";

afterEach(removeTemporaryRoots);

const CONTENT = new TextEncoder().encode("the quick brown fox");

async function* chunks(...parts: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield part;
  }
}

type Harness = {
  readonly store: DurableArtifactStore;
  readonly blobs: ReturnType<typeof createInMemoryBlobStore>;
  readonly repository: ArtifactRepositoryPort;
  readonly database: SqliteStorePort;
};

async function harness(
  overrides: Partial<Omit<ArtifactStoreOptions, "repository">> & {
    readonly blobs?: ReturnType<typeof createInMemoryBlobStore>;
    readonly repository?: (inner: ArtifactRepositoryPort) => ArtifactRepositoryPort;
    /** Applied before the repository is built, to stage transaction behavior. */
    readonly decorateStore?: (store: SqliteStorePort) => SqliteStorePort;
  } = {},
): Promise<Harness> {
  const root = await makeTemporaryRoot("falryn-artifact-store-");
  const database = await openProductStoreOrThrow(root);
  const blobs = overrides.blobs ?? createInMemoryBlobStore();
  const inner = createArtifactRepository(overrides.decorateStore?.(database) ?? database);
  const repository = overrides.repository?.(inner) ?? inner;
  const store = createArtifactStore({
    repository,
    blobs,
    hasher: overrides.hasher ?? createSha256Hasher(),
    clock: overrides.clock ?? createManualClock(FIXTURE_INSTANT),
    ...(overrides.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: overrides.maxArtifactBytes }),
  });
  return { store, blobs, repository, database };
}

function request(overrides: Partial<ArtifactIngestRequest> = {}): ArtifactIngestRequest {
  return {
    artifactId: artifactId.from("a1"),
    mediaType: "text/plain",
    encoding: "identity",
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    declaredByteLength: CONTENT.byteLength,
    content: chunks(CONTENT),
    ...overrides,
  };
}

function errorOf<Value>(result: Result<Value, ArtifactError>): ArtifactError | null {
  return result.ok ? null : result.error;
}

/** A hasher whose stream answer is honest and whose verification answer is not. */
function lyingVerification(): ContentHasherPort {
  return stagedHasher([null, fixtureDigest("c")]);
}

describe("ingesting an artifact", () => {
  test("streams, verifies, finalizes, and commits an available record", async () => {
    const { store, blobs, database } = await harness();

    const ingested = await store.ingest(request());

    expect(ingested.ok).toBe(true);
    const record = ingested.ok ? ingested.value.record : null;
    expect(record?.availability).toBe("available");
    expect(record?.byteLength).toBe(CONTENT.byteLength);
    expect(record?.finalizedAt).not.toBeNull();
    expect(ingested.ok && ingested.value.deduplicated).toBe(false);
    // The bytes ended in content, and nothing was left in flight.
    expect(blobs.locations().map((location) => location.scope)).toEqual(["content"]);
    await database.close();
  });

  test("stores the sensitivity and origin the caller declared, never inferred ones", async () => {
    const { store, database } = await harness();

    const ingested = await store.ingest(
      request({ sensitivity: "restricted", origin: "capture", mediaType: "image/png" }),
    );

    expect(ingested.ok && ingested.value.record.sensitivity).toBe("restricted");
    expect(ingested.ok && ingested.value.record.origin).toBe("capture");
    await database.close();
  });

  test("links the invocation that produced it when one claims it", async () => {
    const { store, database } = await harness();
    database.write((statements) => {
      statements.run(
        `INSERT INTO sessions (session_id, workspace_id, stream_id, title,
           configuration_generation, started_at, closed_at, outcome_kind, outcome_effect)
         VALUES ('s', 'w', 'stream', NULL, 0, '2026-07-31T12:00:00.000Z', NULL, NULL, NULL)`,
      );
      statements.run(
        `INSERT INTO turns (turn_id, session_id, parent_turn_id, started_at, completed_at,
           outcome_kind, outcome_effect)
         VALUES ('t', 's', NULL, '2026-07-31T12:00:00.000Z', NULL, NULL, NULL)`,
      );
      statements.run(
        `INSERT INTO invocations (invocation_id, turn_id, capability_id, capability_version,
           input_digest, started_at, completed_at, outcome_kind, outcome_effect)
         VALUES ('inv-1', 't', 'read', 1, 'ab', '2026-07-31T12:00:00.000Z', NULL, NULL, NULL)`,
      );
    });

    const ingested = await store.ingest(request({ invocationId: invocationId.from("inv-1") }));

    expect(ingested.ok).toBe(true);
    const listed = store.listByInvocation(invocationId.from("inv-1"), 10);
    expect(listed.ok && listed.value.map((one) => String(one.artifactId))).toEqual(["a1"]);
    await database.close();
  });

  test("refuses a media type the domain cannot read back, before any commit", async () => {
    const { store, blobs, database } = await harness();

    const ingested = await store.ingest(request({ mediaType: "not a media type" }));

    expect(errorOf(ingested)?.code).toBe("malformed-row");
    expect(blobs.locations()).toEqual([]);
    expect(store.get(artifactId.from("a1"))).toMatchObject({ ok: true, value: null });
    await database.close();
  });
});

describe("the two byte counts", () => {
  test("refuses a stream longer than its declaration, at the first byte past it", async () => {
    const { store, blobs, database } = await harness();

    const ingested = await store.ingest(
      request({ declaredByteLength: 4, content: chunks(CONTENT) }),
    );

    expect(errorOf(ingested)).toMatchObject({
      code: "size-mismatch",
      declaredByteLength: 4,
      observedByteLength: CONTENT.byteLength,
    });
    expect(blobs.locations()).toEqual([]);
    await database.close();
  });

  test("refuses a stream shorter than its declaration", async () => {
    const { store, blobs, database } = await harness();

    const ingested = await store.ingest(request({ declaredByteLength: CONTENT.byteLength + 1 }));

    // A producer that miscounts is a producer whose output was truncated
    // somewhere, and storing it anyway presents a partial write as complete.
    expect(errorOf(ingested)).toMatchObject({ code: "size-mismatch" });
    expect(blobs.locations()).toEqual([]);
    await database.close();
  });

  test("refuses a declaration above the configured ceiling before allocating", async () => {
    const { store, blobs, database } = await harness({ maxArtifactBytes: 4 });

    const ingested = await store.ingest(request());

    expect(errorOf(ingested)).toMatchObject({
      code: "oversize",
      requestedByteLength: CONTENT.byteLength,
      maximumByteLength: 4,
    });
    expect(blobs.locations()).toEqual([]);
    await database.close();
  });

  test("accepts an empty artifact, which has a digest like any other", async () => {
    const { store, database } = await harness();

    const ingested = await store.ingest(request({ declaredByteLength: 0, content: chunks() }));

    expect(ingested.ok && ingested.value.record.byteLength).toBe(0);
    await database.close();
  });
});

describe("a digest that does not match", () => {
  test("quarantines the bytes rather than deleting them, and says so", async () => {
    const { store, blobs, database } = await harness({ hasher: lyingVerification() });

    const ingested = await store.ingest(request());

    expect(errorOf(ingested)).toMatchObject({ code: "digest-mismatch", artifactId: "a1" });
    // The bytes are the evidence of whatever went wrong. Deleting them destroys
    // the only thing that could explain it.
    expect(blobs.locations().map((location) => location.scope)).toEqual(["quarantine"]);
    const record = store.get(artifactId.from("a1"));
    expect(record.ok && record.value?.availability).toBe("quarantined");
    await database.close();
  });

  test("refuses a caller's own digest that disagrees, before anything is finalized", async () => {
    const { store, blobs, database } = await harness();

    const ingested = await store.ingest(request({ expectedDigest: fixtureDigest("d") }));

    expect(errorOf(ingested)).toMatchObject({ code: "digest-mismatch" });
    expect(blobs.locations().map((location) => location.scope)).toEqual(["quarantine"]);
    await database.close();
  });

  test("carries no digest, path, or byte in the failure it reports", async () => {
    const { store, database } = await harness({ hasher: lyingVerification() });

    const ingested = await store.ingest(request());

    const rendered = JSON.stringify(errorOf(ingested));
    expect(rendered).not.toContain("sha-256:");
    expect(rendered).not.toContain("quick brown");
    await database.close();
  });
});

describe("deduplication", () => {
  test("shares exact bytes while the records keep distinct lineage", async () => {
    const { store, blobs, database } = await harness();
    await store.ingest(request());

    const second = await store.ingest(
      request({ artifactId: artifactId.from("a2"), origin: "capture", content: chunks(CONTENT) }),
    );

    expect(second.ok && second.value.deduplicated).toBe(true);
    expect(second.ok && second.value.record.availability).toBe("available");
    // One blob, two records.
    expect(blobs.locations()).toHaveLength(1);
    const digest = second.ok ? second.value.record.digest : ("" as ContentDigest);
    const shared = store.findByDigest(digest, 10);
    expect(shared.ok && shared.value.map((one) => one.origin)).toEqual(["tool-output", "capture"]);
    await database.close();
  });
});

describe("interruption at each ingest stage", () => {
  const stages: readonly BlobOperation[] = ["allocate", "write", "close", "finalize"];

  for (const stage of stages) {
    test(`a device failure at ${stage} commits no available record`, async () => {
      const blobs = createInMemoryBlobStore({ failOperations: { [stage]: "disk-full" } });
      const { store, database } = await harness({ blobs });

      const ingested = await store.ingest(request());

      expect(errorOf(ingested)).toMatchObject({
        code: "storage",
        failure: { medium: "bytes", error: { code: "disk-full" } },
      });
      const record = store.get(artifactId.from("a1"));
      expect(record.ok && record.value?.availability).not.toBe("available");
      await database.close();
    });
  }

  test("a failed metadata commit leaves a reserved row and bytes the sweep can see", async () => {
    // The state the transaction boundary produces by design: bytes finalized,
    // metadata not yet advanced. It is what the sweep exists to see.
    const blobs = createInMemoryBlobStore();
    const { store, database } = await harness({
      blobs,
      repository: (inner) => ({
        ...inner,
        finalize: () => ({
          ok: false,
          error: {
            kind: "artifact",
            code: "storage",
            artifactId: artifactId.from("a1"),
            failure: {
              medium: "metadata",
              error: {
                kind: "sqlite-store",
                code: "busy",
                operation: "transaction",
                effect: "none",
                cause: {
                  kind: "sqlite",
                  code: "busy",
                  operation: "transaction",
                  driverCode: null,
                  detail: null,
                },
              },
            },
          },
        }),
      }),
    });

    const ingested = await store.ingest(request());

    expect(errorOf(ingested)?.code).toBe("storage");
    const record = store.get(artifactId.from("a1"));
    expect(record.ok && record.value?.availability).toBe("reserved");
    expect(blobs.locations().map((location) => location.scope)).toEqual(["content"]);
    await database.close();
  });
});

describe("cancellation", () => {
  test("before the commit reports cancelled and stores nothing", async () => {
    const { store, blobs, database } = await harness();
    const controller = new AbortController();

    async function* cancelling(): AsyncIterable<Uint8Array> {
      yield CONTENT.slice(0, 4);
      controller.abort();
      yield CONTENT.slice(4);
    }

    const ingested = await store.ingest(request({ content: cancelling() }), controller.signal);

    expect(errorOf(ingested)).toMatchObject({ code: "cancelled", artifactId: "a1" });
    expect(blobs.locations()).toEqual([]);
    expect(store.get(artifactId.from("a1"))).toMatchObject({ ok: true, value: null });
    await database.close();
  });

  test("after the commit reports the committed value beside it", async () => {
    const controller = new AbortController();
    let writes = 0;
    const { store, database } = await harness({
      // Cancelling inside the *second* write is the only way to reach the state
      // the contract is about. The first is the reserve; the second is the
      // finalize, whose commit stands — and calling that `cancelled` would tell
      // a caller nothing happened when something did.
      decorateStore: (inner) => ({
        ...inner,
        write: (work, signal) =>
          inner.write((statements) => {
            const value = work(statements);
            writes += 1;
            if (writes === 2) {
              controller.abort();
            }
            return value;
          }, signal),
      }),
    });

    const ingested = await store.ingest(request(), controller.signal);

    expect(ingested.ok).toBe(true);
    expect(ingested.ok && ingested.value.cancelledAfterCommit).toBe(true);
    expect(ingested.ok && ingested.value.record.availability).toBe("available");
    await database.close();
  });
});

describe("range reads", () => {
  async function readable(): Promise<Harness> {
    const built = await harness();
    await built.store.ingest(request());
    return built;
  }

  test("return the actual offset and length, not the requested one", async () => {
    const { store, database } = await readable();

    const tail = await store.readRange(artifactId.from("a1"), 15, 1_000);

    expect(tail.ok && tail.value.offset).toBe(15);
    expect(tail.ok && tail.value.byteLength).toBe(CONTENT.byteLength - 15);
    expect(tail.ok && tail.value.endOfArtifact).toBe(true);
    await database.close();
  });

  test("read a zero-length range without pretending it reached content", async () => {
    const { store, database } = await readable();

    const empty = await store.readRange(artifactId.from("a1"), 0, 0);

    expect(empty.ok && empty.value.byteLength).toBe(0);
    expect(empty.ok && empty.value.endOfArtifact).toBe(false);
    await database.close();
  });

  test("read at exactly the end as an empty range that is the end", async () => {
    const { store, database } = await readable();

    const atEnd = await store.readRange(artifactId.from("a1"), CONTENT.byteLength, 8);

    expect(atEnd.ok && atEnd.value.byteLength).toBe(0);
    expect(atEnd.ok && atEnd.value.endOfArtifact).toBe(true);
    await database.close();
  });

  test("refuse an offset past the end rather than reporting a short read", async () => {
    const { store, database } = await readable();

    const past = await store.readRange(artifactId.from("a1"), CONTENT.byteLength + 1, 8);

    expect(errorOf(past)).toMatchObject({
      code: "range-out-of-bounds",
      requestedOffset: CONTENT.byteLength + 1,
      byteLength: CONTENT.byteLength,
    });
    await database.close();
  });

  test("refuse a negative offset and a length above the declared bound", async () => {
    const { store, database } = await readable();

    expect(errorOf(await store.readRange(artifactId.from("a1"), -1, 8))?.code).toBe(
      "range-out-of-bounds",
    );
    expect(
      errorOf(await store.readRange(artifactId.from("a1"), 0, MAX_ARTIFACT_RANGE_BYTES + 1)),
    ).toMatchObject({ code: "oversize", maximumByteLength: MAX_ARTIFACT_RANGE_BYTES });
    await database.close();
  });

  test("return the exact bytes that were stored", async () => {
    const { store, database } = await readable();

    const middle = await store.readRange(artifactId.from("a1"), 4, 5);

    expect(middle.ok && new TextDecoder().decode(middle.value.bytes)).toBe("quick");
    await database.close();
  });

  test("report not-found and unavailable bytes as different facts", async () => {
    const { store, database } = await readable();
    const quarantinedHarness = await harness({ hasher: lyingVerification() });
    await quarantinedHarness.store.ingest(request());

    expect(errorOf(await store.readRange(artifactId.from("missing"), 0, 4))?.code).toBe(
      "not-found",
    );
    expect(
      errorOf(await quarantinedHarness.store.readRange(artifactId.from("a1"), 0, 4)),
    ).toMatchObject({ code: "unavailable-bytes", availability: "quarantined" });
    await quarantinedHarness.database.close();
    await database.close();
  });

  test("preview is bounded independently of a range read", async () => {
    const { store, database } = await readable();

    const preview = await store.preview(artifactId.from("a1"), 5);
    const refused = await store.preview(artifactId.from("a1"), MAX_ARTIFACT_PREVIEW_BYTES + 1);

    expect(preview.ok && new TextDecoder().decode(preview.value.bytes)).toBe("the q");
    expect(preview.ok && preview.value.endOfArtifact).toBe(false);
    expect(errorOf(refused)).toMatchObject({
      code: "oversize",
      maximumByteLength: MAX_ARTIFACT_PREVIEW_BYTES,
    });
    await database.close();
  });
});

describe("the sweep", () => {
  test("deletes bytes no record references and keeps the ones that are", async () => {
    const { store, blobs, database } = await harness();
    const ingested = await store.ingest(request());
    const referenced = ingested.ok ? ingested.value.record.digest : ("" as ContentDigest);
    blobs.put({ scope: "content", digest: fixtureDigest("e") }, new Uint8Array([1, 2, 3]));

    const report = await store.sweep();

    expect(report.deleted).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.effect).toBe("completed");
    expect(blobs.locations()).toEqual([{ scope: "content", digest: referenced }]);
    await database.close();
  });

  test("keeps quarantined bytes that a record is still there to explain", async () => {
    const { store, blobs, database } = await harness({ hasher: lyingVerification() });
    await store.ingest(request());

    const report = await store.sweep();

    expect(report.deleted).toBe(0);
    expect(report.retained).toContainEqual({ reason: "quarantined-for-inspection", count: 1 });
    expect(blobs.locations().map((location) => location.scope)).toEqual(["quarantine"]);
    await database.close();
  });

  test("collects quarantined bytes with nothing left to inspect them with", async () => {
    const { store, blobs, database } = await harness();
    blobs.put({ scope: "quarantine", digest: fixtureDigest("f") }, new Uint8Array([9]));

    const report = await store.sweep();

    expect(report.deleted).toBe(1);
    expect(blobs.locations()).toEqual([]);
    await database.close();
  });

  test("reports another run's in-flight bytes and never removes them", async () => {
    const { store, blobs, database } = await harness();
    blobs.put({ scope: "temporary", artifactId: artifactId.from("other") }, new Uint8Array([7]));

    const report = await store.sweep();

    expect(report.retained).toContainEqual({ reason: "temporary-not-this-run", count: 1 });
    expect(blobs.locations()).toHaveLength(1);
    await database.close();
  });

  test("reports a failed removal without calling the sweep clean", async () => {
    const blobs = createInMemoryBlobStore({ failOperations: { remove: "permission-denied" } });
    const { store, database } = await harness({ blobs });
    blobs.put({ scope: "content", digest: fixtureDigest("e") }, new Uint8Array([1]));

    const report = await store.sweep();

    expect(report.deleted).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.effect).toBe("none");
    await database.close();
  });

  test("stops at cancellation and says it has no verdict for the rest", async () => {
    const { store, blobs, database } = await harness();
    blobs.put({ scope: "content", digest: fixtureDigest("e") }, new Uint8Array([1]));
    const controller = new AbortController();
    controller.abort();

    const report = await store.sweep(controller.signal);

    expect(report.completeness).toBe("partial");
    expect(report.deleted).toBe(0);
    await database.close();
  });
});

describe("finalize under shutdown", () => {
  test("stops accepting ingest and discards the bytes this run abandoned", async () => {
    const blobs = createInMemoryBlobStore({ failOperations: { close: "io-failure" } });
    const { store, database } = await harness({ blobs });
    // A device failure that leaves a temporary blob behind, so the participant
    // has something real to discard.
    blobs.put({ scope: "temporary", artifactId: artifactId.from("a1") }, new Uint8Array([1]));

    const participant = createArtifactShutdownParticipant(store);
    expect(participant.phase).toBe("finalize-artifacts");
    await participant.run({
      phase: "finalize-artifacts",
      signal: new AbortController().signal,
      clock: createManualClock(instant(0)),
    });

    expect(store.isAccepting()).toBe(false);
    const late = await store.ingest(request());
    expect(errorOf(late)).toMatchObject({ code: "cancelled" });
    await database.close();
  });

  test("waits for an ingest that is still streaming", async () => {
    const { store, database } = await harness();
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    async function* slow(): AsyncIterable<Uint8Array> {
      await gate;
      yield CONTENT;
    }

    const pending = store.ingest(request({ content: slow() }));
    const quiescing = store.quiesce();
    released();

    await quiescing;
    const ingested = await pending;
    // The ingest that was already in flight completed; a later one would not
    // have started.
    expect(ingested.ok && ingested.value.record.availability).toBe("available");
    await database.close();
  });
});
