/**
 * Loom ingest, cache, exact retrieval, and redaction.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactIngestRequest,
  type ArtifactStorePort,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { err, ok } from "../domain/result.ts";
import { createLoomPort, loomProjectionToEvidence } from "./loom.ts";
import { REDACTED } from "./redaction.ts";

const encoder = new TextEncoder();
const TEXT = "export const ok = true;\nline two\n";
const TEXT_BYTES = encoder.encode(TEXT);

function digestOf(bytes: Uint8Array): ReturnType<typeof contentDigest.from> {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

function createMemoryArtifacts(): ArtifactStorePort & {
  readonly stored: Map<string, Uint8Array>;
  drop(id: string): void;
} {
  const stored = new Map<string, Uint8Array>();
  const records = new Map<string, ReturnType<ArtifactStorePort["get"]>>();
  return {
    stored,
    drop(id) {
      stored.delete(id);
      records.delete(id);
    },
    async ingest(request: ArtifactIngestRequest) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of request.content) {
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      stored.set(request.artifactId, bytes);
      const record = {
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
        availability: "available" as const,
      };
      records.set(request.artifactId, ok(record));
      return ok({ record, deduplicated: false, cancelledAfterCommit: false });
    },
    get(id) {
      return records.get(id) ?? ok(null);
    },
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    async readRange(id, offset, length) {
      const bytes = stored.get(id);
      if (bytes === undefined) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
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
      err({ kind: "artifact", code: "not-found", artifactId: artifactId.from("missing") }),
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

describe("createLoomPort", () => {
  test("ingests required members then retrieves exact source", async () => {
    const loom = createLoomPort({ artifacts: createMemoryArtifacts() });
    const ingested = await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "src-main",
          bytes: TEXT_BYTES,
          mediaType: "text/plain",
          sensitivity: "user-content",
          protectedFacts: ["path=src/main.ts"],
        },
      ],
    });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) {
      return;
    }
    expect(ingested.value.manifest.exactRecoverable).toBe(true);
    const retrieved = await loom.retrieve({
      id: "ev-1",
      manifestId: "loom-1",
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      projection: { kind: "exact", member: "src-main" },
    });
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.claimsExact).toBe(true);
    expect(retrieved.value.text).toBe(TEXT);
    const evidence = loomProjectionToEvidence({ projection: retrieved.value, workspaceId: "ws-1" });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) {
      return;
    }
    expect(evidence.value.fidelity).toBe("exact-source");
  });

  test("does not commit when a required ingest fails", async () => {
    const artifacts = createMemoryArtifacts();
    artifacts.ingest = async (request) =>
      err({ kind: "artifact", code: "not-found", artifactId: request.artifactId });
    const loom = createLoomPort({ artifacts });
    const ingested = await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "src-main",
          bytes: TEXT_BYTES,
          mediaType: "text/plain",
          sensitivity: "user-content",
        },
      ],
    });
    expect(ingested.ok).toBe(false);
    expect(loom.get("loom-1")).toBeNull();
  });

  test("redacts secret-shaped projection text and never claims exact-source", async () => {
    const loom = createLoomPort({ artifacts: createMemoryArtifacts() });
    const secret = encoder.encode("token=sk-live-SECRET-MUST-NOT-ESCAPE\n");
    const ingested = await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "secret-log",
          bytes: secret,
          mediaType: "text/plain",
          sensitivity: "user-content",
        },
      ],
    });
    expect(ingested.ok).toBe(true);
    const retrieved = await loom.retrieve({
      id: "ev-1",
      manifestId: "loom-1",
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      projection: { kind: "exact", member: "secret-log" },
    });
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.claimsExact).toBe(false);
    expect(retrieved.value.fidelity).toBe("deterministic-transform");
    expect(retrieved.value.text).toContain(REDACTED);
    expect(retrieved.value.text).not.toContain("sk-live-SECRET");
    const evidence = loomProjectionToEvidence({ projection: retrieved.value });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) {
      return;
    }
    expect(evidence.value.fidelity).toBe("deterministic-transform");
  });

  test("honours cancellation before ingest", async () => {
    const loom = createLoomPort({ artifacts: createMemoryArtifacts() });
    const ingested = await loom.ingest(
      {
        id: "loom-1",
        workspaceId: "ws-1",
        sessionId: "sess-1",
        members: [
          {
            artifactId: "src-main",
            bytes: TEXT_BYTES,
            mediaType: "text/plain",
            sensitivity: "user-content",
          },
        ],
      },
      AbortSignal.abort(),
    );
    expect(ingested).toEqual({
      ok: false,
      error: { kind: "loom-port", code: "cancelled", field: "signal" },
    });
  });

  test("reports missing cache after artifact loss as unavailable", async () => {
    const artifacts = createMemoryArtifacts();
    const loom = createLoomPort({ artifacts });
    const ingested = await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "src-main",
          bytes: TEXT_BYTES,
          mediaType: "text/plain",
          sensitivity: "user-content",
        },
      ],
    });
    expect(ingested.ok).toBe(true);
    artifacts.drop("src-main");
    const retrieved = await loom.retrieve({
      id: "ev-1",
      manifestId: "loom-1",
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      projection: { kind: "exact", member: "src-main" },
    });
    expect(retrieved.ok).toBe(false);
    if (retrieved.ok) {
      return;
    }
    expect(retrieved.error).toEqual({ kind: "loom", code: "unavailable", field: "member" });
  });

  test("reuses cache then drops it on invalidation", async () => {
    const loom = createLoomPort({ artifacts: createMemoryArtifacts() });
    await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "src-main",
          bytes: TEXT_BYTES,
          mediaType: "text/plain",
          sensitivity: "user-content",
        },
      ],
    });
    const first = await loom.retrieve({
      id: "ev-1",
      manifestId: "loom-1",
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      projection: { kind: "range", member: "src-main", offset: 0, length: 6 },
    });
    const second = await loom.retrieve({
      id: "ev-1",
      manifestId: "loom-1",
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      projection: { kind: "range", member: "src-main", offset: 0, length: 6 },
    });
    expect(first.ok && first.value.cache).toBe("miss");
    expect(second.ok && second.value.cache).toBe("hit");
    expect(first.ok && first.value.claimsExact).toBe(false);
    expect(loom.invalidate({ all: true })).toBe(1);
  });
});
