/**
 * Product Loom context/recovery (#719).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactIngestRequest,
  type ArtifactStorePort,
  artifactId as artifactIdCodec,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { err, ok } from "../domain/result.ts";
import { createLoomPort } from "./loom.ts";
import { composeProductLoomContext, PRODUCT_LOOM_OWNER } from "./product-loom.ts";

const encoder = new TextEncoder();
const TEXT = "export const loomed = true;\n";
const TEXT_BYTES = encoder.encode(TEXT);

function digestOf(bytes: Uint8Array) {
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
      err({ kind: "artifact", code: "not-found", artifactId: artifactIdCodec.from("missing") }),
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

describe("composeProductLoomContext", () => {
  test("retrieves Loom evidence and attaches recovery handles", async () => {
    const loom = createLoomPort({ artifacts: createMemoryArtifacts() });
    const ingested = await loom.ingest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [
        {
          artifactId: "member-1",
          bytes: TEXT_BYTES,
          mediaType: "text/plain",
          sensitivity: "user-content",
        },
      ],
    });
    expect(ingested.ok).toBe(true);

    const product = composeProductLoomContext({ loom });
    expect(product.owner).toBe(PRODUCT_LOOM_OWNER);
    const evidence = await product.retrieveEvidence({
      retrieve: {
        id: "ev-1",
        manifestId: "loom-1",
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        projection: { kind: "exact", member: "member-1" },
      },
      workspaceId: "ws-1",
    });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) {
      return;
    }
    expect(evidence.value.origin).toContain("loom:");

    const recovered = product.attachRecovery(
      { projection: "reduced" },
      "loom-1",
      evidence.ok ? null : null,
    );
    expect(recovered.loomRecovery.manifestId).toBe("loom-1");
    expect(recovered.loomRecovery.owner).toBe(PRODUCT_LOOM_OWNER);
  });
});
