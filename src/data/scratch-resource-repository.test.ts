import { afterEach, describe, expect, test } from "bun:test";

import {
  artifactId,
  configurationGeneration,
  instant,
  invocationId,
  parseScratchMediaType,
  parseScratchName,
  scratchRevision,
  sessionId,
} from "../domain/index.ts";
import {
  fixtureDigest,
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "./fixtures.ts";
import { createScratchResourceRepository } from "./scratch-resource-repository.ts";

afterEach(removeTemporaryRoots);

function mustName(value: string) {
  const parsed = parseScratchName(value);
  if (!parsed.ok) throw new Error("invalid scratch fixture name");
  return parsed.value;
}

function mustMediaType(value: string) {
  const parsed = parseScratchMediaType(value);
  if (!parsed.ok) throw new Error("invalid scratch fixture media type");
  return parsed.value;
}

function revision(value: number) {
  const parsed = scratchRevision(value);
  if (!parsed.ok) throw new Error("invalid scratch fixture revision");
  return parsed.value;
}

function seed(store: Awaited<ReturnType<typeof openProductStoreOrThrow>>, artifact: string): void {
  const digest = fixtureDigest(artifact.endsWith("1") ? "a" : "b");
  const inserted = store.write((statements) => {
    statements.run(
      `INSERT OR IGNORE INTO sessions
        (session_id, workspace_id, stream_id, configuration_generation, started_at)
       VALUES ('session-scratch', 'workspace-1', 'stream-scratch', $generation,
         '2026-08-28T12:00:00.000Z')`,
      { generation: configurationGeneration.from(1) },
    );
    statements.run(
      `INSERT INTO artifacts
        (artifact_id, digest, media_type, encoding, byte_length, sensitivity, origin,
         invocation_id, created_at, finalized_at, availability)
       VALUES ($artifactId, $digest, 'text/markdown', 'identity', 5,
         'user-content', 'model-output', NULL, '2026-08-28T12:00:00.000Z',
         '2026-08-28T12:00:00.000Z', 'available')`,
      { artifactId: artifact, digest },
    );
  });
  expect(inserted.ok).toBe(true);
}

describe("scratch resource repository", () => {
  test("publishes immutable revisions, reopens them, and tombstones with CAS", async () => {
    const root = await temporaryRoot("falryn-scratch-repository-");
    const firstStore = await openProductStoreOrThrow(root);
    seed(firstStore, "scratch-artifact-1");
    seed(firstStore, "scratch-artifact-2");
    const repository = createScratchResourceRepository(firstStore);
    const owner = sessionId.from("session-scratch");
    const name = mustName("pr-body.md");

    const first = repository.publish({
      sessionId: owner,
      name,
      expectedRevision: null,
      revision: {
        sessionId: owner,
        name,
        revision: revision(1),
        artifactId: artifactId.from("scratch-artifact-1"),
        digest: fixtureDigest("a"),
        mediaType: mustMediaType("text/markdown"),
        byteLength: 5,
        invocationId: invocationId.from("inv-scratch-1"),
        createdAt: instant(10),
      },
    });
    expect(first).toMatchObject({ ok: true, value: { resource: { currentRevision: 1 } } });
    expect(
      repository.publish({
        sessionId: owner,
        name,
        expectedRevision: null,
        revision: {
          sessionId: owner,
          name,
          revision: revision(1),
          artifactId: artifactId.from("scratch-artifact-1"),
          digest: fixtureDigest("a"),
          mediaType: mustMediaType("text/markdown"),
          byteLength: 5,
          invocationId: invocationId.from("inv-scratch-1"),
          createdAt: instant(10),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });

    const second = repository.publish({
      sessionId: owner,
      name,
      expectedRevision: revision(1),
      revision: {
        sessionId: owner,
        name,
        revision: revision(2),
        artifactId: artifactId.from("scratch-artifact-2"),
        digest: fixtureDigest("b"),
        mediaType: mustMediaType("text/markdown"),
        byteLength: 5,
        invocationId: invocationId.from("inv-scratch-2"),
        createdAt: instant(20),
      },
    });
    expect(second).toMatchObject({ ok: true, value: { resource: { currentRevision: 2 } } });
    expect(repository.get(owner, name, revision(1))).toMatchObject({
      ok: true,
      value: { revision: { artifactId: "scratch-artifact-1" } },
    });
    expect(repository.list(owner, 10)).toMatchObject({
      ok: true,
      value: [{ revision: { artifactId: "scratch-artifact-2" } }],
    });
    await firstStore.close();

    const secondStore = await openProductStoreOrThrow(root);
    const reopened = createScratchResourceRepository(secondStore);
    expect(reopened.get(owner, name)).toMatchObject({
      ok: true,
      value: { resource: { currentRevision: 2 }, revision: { revision: 2 } },
    });
    expect(reopened.discard(owner, name, revision(1), instant(30))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(reopened.discard(owner, name, revision(2), instant(30))).toMatchObject({
      ok: true,
      value: { resource: { status: "discarded" }, revision: { revision: 2 } },
    });
    expect(reopened.get(owner, name)).toMatchObject({
      ok: false,
      error: { code: "discarded" },
    });
    expect(reopened.list(owner, 10)).toEqual({ ok: true, value: [] });
    await secondStore.close();
  });
});
