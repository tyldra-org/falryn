import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactIngestRequest,
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  createManualClock,
  err,
  instant,
  invocationId,
  ok,
  parseScratchName,
  type ScratchResourceRepositoryPort,
  type ScratchResourceView,
  scratchHandle,
  sessionId,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { createScratchResources } from "./scratch-resources.ts";

function digestOf(bytes: Uint8Array) {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

function memoryArtifacts(): ArtifactStorePort {
  const records = new Map<string, ArtifactRecord>();
  const stored = new Map<string, Uint8Array>();
  return {
    async ingest(request: ArtifactIngestRequest) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.content) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const record: ArtifactRecord = {
        artifactId: request.artifactId,
        digest: digestOf(bytes),
        mediaType: request.mediaType,
        encoding: request.encoding,
        byteLength: bytes.byteLength,
        sensitivity: request.sensitivity,
        origin: request.origin,
        invocationId: request.invocationId,
        createdAt: timestampFromEpochMilliseconds(0),
        finalizedAt: timestampFromEpochMilliseconds(0),
        availability: "available",
      };
      records.set(request.artifactId, record);
      stored.set(request.artifactId, bytes);
      return ok({ record, deduplicated: false, cancelledAfterCommit: false });
    },
    get: (id) => ok(records.get(id) ?? null),
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    async readRange(id, offset, length) {
      const bytes = stored.get(id);
      if (bytes === undefined) return err({ kind: "artifact", code: "not-found", artifactId: id });
      const slice = bytes.subarray(offset, offset + length);
      return ok({
        artifactId: id,
        offset,
        byteLength: slice.byteLength,
        bytes: slice,
        endOfArtifact: offset + slice.byteLength >= bytes.byteLength,
      });
    },
    preview: async () =>
      err({ kind: "artifact", code: "not-found", artifactId: artifactId.from("none") }),
    sweep: async () => ({
      examined: 0,
      deleted: 0,
      retained: [],
      failed: 0,
      completeness: "complete",
      effect: "none",
    }),
  };
}

function memoryRepository(): ScratchResourceRepositoryPort {
  const current = new Map<string, ScratchResourceView>();
  const revisions = new Map<string, ScratchResourceView>();
  const key = (owner: string, name: string) => `${owner}\0${name}`;
  const revisionKey = (owner: string, name: string, revision: number) =>
    `${key(owner, name)}\0${revision}`;
  return {
    publish(input) {
      const identity = key(input.sessionId, input.name);
      const existing = current.get(identity);
      if (
        (existing === undefined && input.expectedRevision !== null) ||
        (existing !== undefined &&
          (input.expectedRevision === null ||
            existing.resource.currentRevision !== input.expectedRevision))
      ) {
        return err({ kind: "scratch-resource", code: "conflict" });
      }
      const view: ScratchResourceView = {
        resource: {
          sessionId: input.sessionId,
          name: input.name,
          status: "active",
          currentRevision: input.revision.revision,
          createdAt: existing?.resource.createdAt ?? input.revision.createdAt,
          updatedAt: input.revision.createdAt,
        },
        revision: input.revision,
      };
      current.set(identity, view);
      revisions.set(revisionKey(input.sessionId, input.name, input.revision.revision), view);
      return ok(view);
    },
    get(owner, name, revision) {
      const view =
        revision === undefined
          ? current.get(key(owner, name))
          : revisions.get(revisionKey(owner, name, revision));
      if (view?.resource.status === "discarded") {
        return err({ kind: "scratch-resource", code: "discarded" });
      }
      return ok(view ?? null);
    },
    list(owner, limit) {
      return ok(
        [...current.values()]
          .filter((view) => view.resource.sessionId === owner && view.resource.status === "active")
          .slice(0, limit),
      );
    },
    discard(owner, name, expectedRevision, updatedAt) {
      const identity = key(owner, name);
      const view = current.get(identity);
      if (view === undefined) return err({ kind: "scratch-resource", code: "not-found" });
      if (view.resource.currentRevision !== expectedRevision) {
        return err({ kind: "scratch-resource", code: "conflict" });
      }
      const discarded: ScratchResourceView = {
        ...view,
        resource: { ...view.resource, status: "discarded", updatedAt },
      };
      current.set(identity, discarded);
      return ok(discarded);
    },
  };
}

describe("scratch resource orchestration", () => {
  test("retains exact revisions and exposes only the stable handle", async () => {
    const owner = sessionId.from("session-one");
    let sequence = 0;
    const scratch = createScratchResources({
      artifacts: memoryArtifacts(),
      repository: memoryRepository(),
      clock: createManualClock(instant(10)),
      createArtifactId: () => artifactId.from(`scratch-test-${++sequence}`),
    });
    const created = await scratch.write({
      sessionId: owner,
      invocationId: invocationId.from("inv-one"),
      name: "pr-body.md",
      text: "first draft",
      mediaType: "text/markdown",
    });
    expect(created).toMatchObject({
      ok: true,
      value: {
        handle: "scratch://session/session-one/pr-body.md",
        revision: 1,
        mediaType: "text/markdown",
        byteLength: 11,
      },
    });
    expect(JSON.stringify(created)).not.toContain("scratch-test-1");
    if (!created.ok) return;

    const revised = await scratch.write({
      sessionId: owner,
      invocationId: invocationId.from("inv-two"),
      name: "pr-body.md",
      text: "second draft",
      mediaType: "text/markdown",
      expectedRevision: 1,
    });
    expect(revised).toMatchObject({ ok: true, value: { revision: 2, byteLength: 12 } });
    expect(await scratch.read(owner, created.value.handle, 1)).toMatchObject({
      ok: true,
      value: { revision: 1, text: "first draft" },
    });
    expect(await scratch.read(owner, created.value.handle)).toMatchObject({
      ok: true,
      value: { revision: 2, text: "second draft" },
    });
    expect(scratch.list(owner)).toMatchObject({ ok: true, value: [{ revision: 2 }] });
    expect(scratch.discard(owner, created.value.handle, 1)).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(scratch.discard(owner, created.value.handle, 2)).toMatchObject({
      ok: true,
      value: { status: "discarded", revision: 2 },
    });
    expect(await scratch.read(owner, created.value.handle)).toMatchObject({
      ok: false,
      error: { code: "discarded" },
    });
  });

  test("refuses stale writes and cross-session handles", async () => {
    const owner = sessionId.from("session-one");
    const name = parseScratchName("notes.md");
    if (!name.ok) throw new Error("fixture name invalid");
    const scratch = createScratchResources({
      artifacts: memoryArtifacts(),
      repository: memoryRepository(),
      clock: createManualClock(instant(10)),
      createArtifactId: () => artifactId.from("scratch-test-one"),
    });
    expect(
      await scratch.write({
        sessionId: owner,
        invocationId: invocationId.from("inv-one"),
        name: name.value,
        text: "draft",
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await scratch.read(owner, scratchHandle(sessionId.from("session-two"), name.value)),
    ).toMatchObject({ ok: false, error: { code: "cross-session" } });
  });

  test("fails cancelled and unavailable writes without retaining input in the error", async () => {
    const owner = sessionId.from("session-one");
    const artifacts = memoryArtifacts();
    const repository = memoryRepository();
    const scratch = createScratchResources({
      artifacts,
      repository,
      clock: createManualClock(instant(10)),
      createArtifactId: () => artifactId.from("scratch-test-cancelled"),
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await scratch.write(
      {
        sessionId: owner,
        invocationId: invocationId.from("inv-cancelled"),
        name: "cancelled.md",
        text: "content that must not enter an error",
      },
      controller.signal,
    );
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(repository.list(owner, 10)).toEqual({ ok: true, value: [] });
    expect(JSON.stringify(cancelled)).not.toContain("content that must not enter an error");

    const unavailable = createScratchResources({
      artifacts,
      repository: {
        ...repository,
        get: () => err({ kind: "scratch-resource", code: "unavailable" }),
      },
      clock: createManualClock(instant(10)),
    });
    const failed = await unavailable.write({
      sessionId: owner,
      invocationId: invocationId.from("inv-unavailable"),
      name: "unavailable.md",
      text: "another private draft",
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(JSON.stringify(failed)).not.toContain("another private draft");
  });
});
