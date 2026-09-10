import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createArtifactRepository } from "../../data/artifacts/artifact-repository.ts";
import { createArtifactStore } from "../../data/artifacts/artifact-store.ts";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { planReachabilityGc } from "../../data/lifecycle/reachability-gc.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { createRecordRepositories } from "../../data/sessions/repositories.ts";
import { artifactId, createInMemoryBlobStore } from "../../domain/artifacts/index.ts";
import { createInMemoryPackageWriter } from "../../domain/extensions/index.ts";
import { sessionRecord } from "../../domain/fixtures.ts";
import {
  createManualClock,
  runId,
  sessionId,
  streamId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createSha256Hasher } from "../../integrations/index.ts";
import { createRuntimeRedactor } from "../diagnostics/redaction.ts";
import { rewindWorkspaceSession } from "../sessions/session-rewind.ts";
import { dataManifest, packageDataFixture, stateFamily } from "./package-data.fixtures.ts";
import type { PackageDataResult } from "./package-data.ts";

afterEach(removeTemporaryRoots);
function confirm(run: (request: unknown) => PackageDataResult, request: object) {
  const preview = run(request);
  if (preview.status !== "preview") throw new Error(JSON.stringify(preview));
  return run({ ...request, confirmation: preview.confirmation });
}
test("artifact references require exact available bytes and survive GC while active or retained for recovery", async () => {
  const fixture = await packageDataFixture();
  try {
    expect(
      await fixture.apply(
        "update",
        fixture.request(1),
        dataManifest("2.0.0", { ...stateFamily, schema: { type: "artifact" } }),
      ),
    ).toMatchObject({ status: "completed" });
    const blobs = createInMemoryBlobStore();
    const clock = createManualClock();
    fixture.store.write((sql) =>
      sql.run(
        "INSERT INTO runs(run_id,started_at,ended_at,schema_version) VALUES('package-artifact','2026-07-31T12:00:00.000Z',NULL,3)",
      ),
    );
    const artifacts = createArtifactStore({
      repository: createArtifactRepository(fixture.store, runId.from("package-artifact")),
      blobs,
      clock,
      hasher: createSha256Hasher(),
    });
    const bytes = new TextEncoder().encode("owned artifact bytes");
    const ingested = await artifacts.ingest({
      artifactId: artifactId.from("package-artifact"),
      mediaType: "text/plain",
      encoding: "identity",
      sensitivity: "public",
      origin: "user-supplied",
      invocationId: null,
      declaredByteLength: bytes.byteLength,
      content: (async function* () {
        yield bytes;
      })(),
    });
    if (!ingested.ok) throw new Error("artifact ingest failed");
    const reference = {
      kind: "artifact-reference",
      artifactId: ingested.value.record.artifactId,
      digest: ingested.value.record.digest,
      bytes: bytes.byteLength,
    };
    const request = {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 2,
      state: {
        version: 1,
        operation: "put",
        identity: fixture.identity,
        expectedRevision: 0,
        value: reference,
      },
    };
    expect(
      fixture.service().run({
        ...request,
        state: { ...request.state, value: { ...reference, artifactId: "absent" } },
      }),
    ).toMatchObject({ status: "failed", code: "package-artifact-unavailable" });
    expect(confirm(fixture.service().run, request)).toMatchObject({ status: "completed" });
    const packages = createInMemoryPackageWriter();
    const repositories = createRecordRepositories(fixture.store);
    const options = {
      store: fixture.store,
      repositories,
      blobs,
      packages,
      exportOptions: {
        store: fixture.store,
        repositories,
        events: createSqliteEventStore(fixture.store),
        blobs,
        packages,
        clock,
        hasher: createSha256Hasher(),
        buildIdentity: "test",
        redactor: createRuntimeRedactor(),
      },
      pinnedSessionIds: [],
      exportPackageNames: [],
    };
    expect(await planReachabilityGc(options)).toMatchObject({
      ok: true,
      value: { candidateArtifacts: 0 },
    });
    expect(
      confirm(fixture.service().run, {
        version: 1,
        operation: "state",
        operationId: randomUUID(),
        expectedRevision: 3,
        state: { version: 1, operation: "delete", identity: fixture.identity, expectedRevision: 1 },
      }),
    ).toMatchObject({ status: "completed" });
    expect(await planReachabilityGc(options)).toMatchObject({
      ok: true,
      value: { candidateArtifacts: 0 },
    });
  } finally {
    await fixture.store.close();
  }
});

test("native session fork copies declared state atomically under a new owner and generation", async () => {
  const fixture = await packageDataFixture();
  try {
    const repositories = createRecordRepositories(fixture.store);
    const source = sessionRecord({
      sessionId: sessionId.from("session-a"),
      streamId: streamId.from("stream-a"),
    });
    expect(repositories.sessions.insert(source).ok).toBe(true);
    expect(
      confirm(fixture.service().run, {
        version: 1,
        operation: "state",
        operationId: randomUUID(),
        expectedRevision: 1,
        state: {
          version: 1,
          operation: "put",
          identity: { ...fixture.identity, scope: "session", owner: source.sessionId },
          expectedRevision: 0,
          value: { color: "blue" },
        },
      }),
    ).toMatchObject({ status: "completed" });
    const fork = rewindWorkspaceSession(repositories.sessions, repositories.turns, {
      sourceSessionId: source.sessionId,
      identities: {
        sessionId: sessionId.from("session-b"),
        streamId: streamId.from("stream-b"),
        workspaceId: workspaceId.from("workspace-b"),
      },
      edit: { kind: "fork" },
    });
    expect(fork.ok).toBe(true);
    const read = fixture.data.read("fixture");
    expect(read).toMatchObject({
      ok: true,
      value: {
        records: [
          { identity: { owner: "session-a" } },
          { identity: { owner: "session-b" }, revision: 1, value: { color: "blue" } },
        ],
      },
    });
    if (read.ok)
      expect(read.value?.records[0]?.binding.sessionGeneration).not.toBe(
        read.value?.records[1]?.binding.sessionGeneration,
      );
  } finally {
    await fixture.store.close();
  }
});

test("native session closure tombstones only declared session-lifetime removal state", async () => {
  const fixture = await packageDataFixture();
  try {
    expect(
      await fixture.apply(
        "update",
        fixture.request(1),
        dataManifest("1.1.0", { ...stateFamily, retention: "session", cleanup: "remove" }),
      ),
    ).toMatchObject({ status: "completed" });
    const repositories = createRecordRepositories(fixture.store);
    const session = sessionRecord({ sessionId: sessionId.from("session-close") });
    expect(repositories.sessions.insert(session).ok).toBe(true);
    expect(
      confirm(fixture.service().run, {
        version: 1,
        operation: "state",
        operationId: randomUUID(),
        expectedRevision: 2,
        state: {
          version: 1,
          operation: "put",
          identity: { ...fixture.identity, scope: "session", owner: session.sessionId },
          expectedRevision: 0,
          value: { color: "blue" },
        },
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      repositories.sessions.complete(session.sessionId, {
        completedAt: session.startedAt,
        outcome: { kind: "completed" },
      }).ok,
    ).toBe(true);
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 4, records: [{ tombstone: true, value: null, revision: 2 }] },
    });
    expect(
      repositories.sessions.complete(session.sessionId, {
        completedAt: session.startedAt,
        outcome: { kind: "completed" },
      }).ok,
    ).toBe(true);
    expect(fixture.data.read("fixture")).toMatchObject({ ok: true, value: { revision: 4 } });
  } finally {
    await fixture.store.close();
  }
});
