/**
 * Provenance edges against a real migrated database.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  ARTIFACT_API_VERSION,
  type ArtifactProvenanceEdge,
  type ArtifactRecord,
  artifactId,
  type LocalPath,
  runId,
  type SqliteStorePort,
  type Timestamp,
} from "../domain/index.ts";
import { createArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import {
  fixtureDigest,
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
  reservedArtifact,
} from "./fixtures.ts";
import { PRODUCT_SCHEMA_VERSION } from "./sqlite-migrations.ts";

const THIS_RUN = runId.from("run-this");
const DIGEST = fixtureDigest("a");
const OTHER = fixtureDigest("b");
const FINALIZED = "2026-07-31T12:00:05.000Z" as Timestamp;

afterEach(removeTemporaryRoots);

async function openGraph(): Promise<{
  readonly store: SqliteStorePort;
  readonly artifacts: ReturnType<typeof createArtifactRepository>;
  readonly provenance: ReturnType<typeof createArtifactProvenanceRepository>;
}> {
  const root: LocalPath = await makeTemporaryRoot("falryn-artifact-provenance-");
  const store = await openProductStoreOrThrow(root);
  store.write((statements) =>
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, $schemaVersion)`,
      { runId: THIS_RUN, schemaVersion: PRODUCT_SCHEMA_VERSION },
    ),
  );
  return {
    store,
    artifacts: createArtifactRepository(store, THIS_RUN),
    provenance: createArtifactProvenanceRepository(store),
  };
}

function available(
  artifacts: ReturnType<typeof createArtifactRepository>,
  id: string,
  digest = DIGEST,
): ArtifactRecord {
  const reserved = reservedArtifact(id, digest);
  artifacts.reserve(reserved);
  artifacts.finalize(artifactId.from(id), FINALIZED);
  const found = artifacts.get(artifactId.from(id));
  if (!found.ok || found.value === null) {
    throw new Error("expected available artifact");
  }
  return found.value;
}

describe("inserting a provenance edge", () => {
  test("records a parent transformation and reads it from both ends", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "parent");
    available(artifacts, "child", OTHER);

    const inserted = provenance.insert({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "derived-from",
      createdAt: FINALIZED,
    });
    expect(inserted.ok).toBe(true);

    const parents = provenance.listParents(artifactId.from("child"));
    expect(parents.ok && parents.value).toHaveLength(1);
    const children = provenance.listChildren(artifactId.from("parent"));
    expect(children.ok && children.value).toHaveLength(1);
    await store.close();
  });

  test("refuses a missing parent inside the transaction", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "child");

    const inserted = provenance.insert({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("ghost"),
      transformation: "copied-from",
      createdAt: FINALIZED,
    });
    expect(inserted.ok).toBe(false);
    expect(inserted.ok || inserted.error).toMatchObject({ code: "missing-parent" });
    await store.close();
  });

  test("refuses a cycle", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "a");
    available(artifacts, "b", OTHER);
    expect(
      provenance.insert({
        schemaVersion: ARTIFACT_API_VERSION,
        childArtifactId: artifactId.from("b"),
        parentArtifactId: artifactId.from("a"),
        transformation: "derived-from",
        createdAt: FINALIZED,
      }).ok,
    ).toBe(true);

    const cycle = provenance.insert({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("a"),
      parentArtifactId: artifactId.from("b"),
      transformation: "derived-from",
      createdAt: FINALIZED,
    });
    expect(cycle.ok || cycle.error).toMatchObject({ code: "cycle" });
    await store.close();
  });

  test("refuses a reserved record", async () => {
    const { store, artifacts, provenance } = await openGraph();
    artifacts.reserve(reservedArtifact("parent", DIGEST));
    available(artifacts, "child", OTHER);

    const inserted = provenance.insert({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "extracted-from",
      createdAt: FINALIZED,
    });
    expect(inserted.ok || inserted.error).toMatchObject({ code: "unavailable" });
    await store.close();
  });

  test("refuses a duplicate edge as already linked", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "parent");
    available(artifacts, "child", OTHER);
    const edge: ArtifactProvenanceEdge = {
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "copied-from",
      createdAt: FINALIZED,
    };
    expect(provenance.insert(edge).ok).toBe(true);
    const repeated = provenance.insert(edge);
    expect(repeated.ok || repeated.error).toMatchObject({ code: "already-linked" });
    await store.close();
  });

  test("refuses a self-parent before the statement runs", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "same");
    const inserted = provenance.insert({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: artifactId.from("same"),
      parentArtifactId: artifactId.from("same"),
      transformation: "derived-from",
      createdAt: FINALIZED,
    });
    expect(inserted.ok || inserted.error).toMatchObject({ code: "self-parent" });
    await store.close();
  });

  test("treats cancellation before commit as cancelled", async () => {
    const { store, artifacts, provenance } = await openGraph();
    available(artifacts, "parent");
    available(artifacts, "child", OTHER);
    const inserted = provenance.insert(
      {
        schemaVersion: ARTIFACT_API_VERSION,
        childArtifactId: artifactId.from("child"),
        parentArtifactId: artifactId.from("parent"),
        transformation: "derived-from",
        createdAt: FINALIZED,
      },
      AbortSignal.abort(),
    );
    expect(inserted.ok || inserted.error).toMatchObject({
      kind: "artifact-api",
      code: "cancelled",
    });
    const parents = provenance.listParents(artifactId.from("child"));
    expect(parents.ok && parents.value).toEqual([]);
    await store.close();
  });
});
