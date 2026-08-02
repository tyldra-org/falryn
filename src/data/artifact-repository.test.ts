/**
 * The artifact metadata repository against a real migrated database.
 *
 * Every check here is about a decision the repository makes *inside* its
 * transaction — whether a row is already there, whether it is still reserved —
 * because those are the decisions that turn into constraint violations a caller
 * would have to interpret if they were made anywhere else.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  type ArtifactRecord,
  artifactId,
  invocationId,
  type LocalPath,
  MAX_ARTIFACT_LIST_LIMIT,
  type SqliteStorePort,
  type Timestamp,
} from "../domain/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import {
  fixtureDigest,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
  reservedArtifact,
} from "./fixtures.ts";

const FINALIZED = "2026-07-31T12:00:05.000Z" as Timestamp;
const DIGEST = fixtureDigest("a");
const OTHER_DIGEST = fixtureDigest("b");

afterEach(removeTemporaryRoots);

async function openRepository(): Promise<{
  readonly store: SqliteStorePort;
  readonly repository: ReturnType<typeof createArtifactRepository>;
}> {
  const root: LocalPath = await makeTemporaryRoot("falryn-artifact-repo-");
  const store = await openProductStoreOrThrow(root);
  return { store, repository: createArtifactRepository(store) };
}

/** An invocation row, so the artifact's foreign key has something to point at. */
function insertInvocation(store: SqliteStorePort, id: string): void {
  store.write((statements) => {
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
       VALUES ($id, 't', 'read', 1, 'ab', '2026-07-31T12:00:00.000Z', NULL, NULL, NULL)`,
      { id },
    );
  });
}

describe("reserving an artifact", () => {
  test("records the incomplete state and reads it back as a record", async () => {
    const { store, repository } = await openRepository();

    expect(repository.reserve(reservedArtifact("a1", DIGEST)).ok).toBe(true);

    const found = repository.get(artifactId.from("a1"));
    expect(found.ok && found.value?.availability).toBe("reserved");
    expect(found.ok && found.value?.finalizedAt).toBeNull();
    await store.close();
  });

  test("reports already-exists rather than a constraint violation", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));

    const repeated = repository.reserve(reservedArtifact("a1", OTHER_DIGEST));

    expect(repeated).toMatchObject({
      ok: false,
      error: { kind: "artifact", code: "already-exists", artifactId: "a1" },
    });
    await store.close();
  });

  test("refuses a record that is not reserved, before it reaches SQL", async () => {
    const { store, repository } = await openRepository();

    const finalized: ArtifactRecord = {
      ...reservedArtifact("a1", DIGEST),
      availability: "available",
      finalizedAt: FINALIZED,
    };

    expect(repository.reserve(finalized)).toMatchObject({
      ok: false,
      error: { kind: "artifact", code: "malformed-row" },
    });
    await store.close();
  });
});

describe("moving an artifact out of the reserved state", () => {
  test("finalizes once and reports already-exists on a second attempt", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));

    expect(repository.finalize(artifactId.from("a1"), FINALIZED).ok).toBe(true);
    const again = repository.finalize(artifactId.from("a1"), FINALIZED);

    // A zero-row update reported as success is how a caller comes to believe a
    // transition happened twice.
    expect(again).toMatchObject({ ok: false, error: { code: "already-exists" } });
    const found = repository.get(artifactId.from("a1"));
    expect(found.ok && found.value?.availability).toBe("available");
    expect(found.ok && found.value?.finalizedAt).toBe(FINALIZED);
    await store.close();
  });

  test("quarantines a reserved row and keeps it readable as metadata", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));

    expect(repository.quarantine(artifactId.from("a1"), FINALIZED).ok).toBe(true);

    const found = repository.get(artifactId.from("a1"));
    expect(found.ok && found.value?.availability).toBe("quarantined");
    await store.close();
  });

  test("reports not-found for a row this database does not hold", async () => {
    const { store, repository } = await openRepository();

    expect(repository.finalize(artifactId.from("missing"), FINALIZED)).toMatchObject({
      ok: false,
      error: { code: "not-found", artifactId: "missing" },
    });
    await store.close();
  });
});

describe("reading artifacts", () => {
  test("answers null for an artifact that is not there", async () => {
    const { store, repository } = await openRepository();
    const found = repository.get(artifactId.from("missing"));
    expect(found.ok && found.value).toBeNull();
    await store.close();
  });

  test("finds every record sharing exact bytes, with distinct lineage", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST, { origin: "tool-output" }));
    repository.reserve(reservedArtifact("a2", DIGEST, { origin: "capture" }));
    repository.reserve(reservedArtifact("a3", OTHER_DIGEST));

    const shared = repository.findByDigest(DIGEST, 10);

    expect(shared.ok && shared.value.map((one) => String(one.artifactId))).toEqual(["a1", "a2"]);
    expect(shared.ok && shared.value.map((one) => one.origin)).toEqual(["tool-output", "capture"]);
    await store.close();
  });

  test("lists an invocation's artifacts and no others", async () => {
    const { store, repository } = await openRepository();
    insertInvocation(store, "inv-1");
    const invocation = invocationId.from("inv-1");
    repository.reserve(reservedArtifact("a1", DIGEST, { invocationId: invocation }));
    repository.reserve(reservedArtifact("a2", OTHER_DIGEST));

    const listed = repository.listByInvocation(invocation, 10);

    expect(listed.ok && listed.value.map((one) => String(one.artifactId))).toEqual(["a1"]);
    await store.close();
  });

  test("refuses a listing bound it has no answer for", async () => {
    const { store, repository } = await openRepository();

    expect(repository.findByDigest(DIGEST, MAX_ARTIFACT_LIST_LIMIT + 1)).toMatchObject({
      ok: false,
      error: { code: "invalid-list-limit", maximumLimit: MAX_ARTIFACT_LIST_LIMIT },
    });
    expect(repository.findByDigest(DIGEST, 0).ok).toBe(false);
    await store.close();
  });

  test("refuses a hand-edited row rather than admitting it into domain state", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));
    // Written past the repository on purpose. The `CHECK` constraints cover the
    // closed unions, so the drift a parser has to catch is a value the schema
    // permits and the domain does not.
    store.write((statements) =>
      statements.run(
        "UPDATE artifacts SET media_type = 'not a media type' WHERE artifact_id = 'a1'",
      ),
    );

    const found = repository.get(artifactId.from("a1"));

    expect(found).toMatchObject({ ok: false, error: { code: "malformed-row" } });
    expect(JSON.stringify(found)).not.toContain("not a media type");
    await store.close();
  });
});

describe("the reference check the sweep depends on", () => {
  test("answers with exactly the digests a record still points at", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));

    const referenced = repository.referencedDigests([DIGEST, OTHER_DIGEST]);

    expect(referenced.ok && [...referenced.value]).toEqual([DIGEST]);
    await store.close();
  });

  test("asks about an empty set without issuing a statement it cannot bind", async () => {
    const { store, repository } = await openRepository();
    const referenced = repository.referencedDigests([]);
    expect(referenced.ok && referenced.value.size).toBe(0);
    await store.close();
  });

  test("batches a set larger than one statement should carry", async () => {
    const { store, repository } = await openRepository();
    repository.reserve(reservedArtifact("a1", DIGEST));
    const many = Array.from({ length: 1_200 }, (_, index) =>
      fixtureDigest(String.fromCodePoint(97 + (index % 6))),
    );

    const referenced = repository.referencedDigests([...many, DIGEST]);

    expect(referenced.ok && referenced.value.has(DIGEST)).toBe(true);
    await store.close();
  });
});
