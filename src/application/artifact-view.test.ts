import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import {
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
  contentDigest,
  ok,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { createArtifactViewer } from "./artifact-view.ts";

const id = artifactId.from("view-1");
const digest = contentDigest.from(`sha-256:${"a".repeat(64)}`);

function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: id,
    digest,
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 11,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: timestampFromEpochMilliseconds(0),
    finalizedAt: timestampFromEpochMilliseconds(1),
    availability: "available",
    ...overrides,
  };
}

function store(
  bytes: Uint8Array,
  meta: ArtifactRecord = record({ byteLength: bytes.byteLength }),
  overrides: Partial<ArtifactStorePort> = {},
): ArtifactStorePort {
  return {
    ingest: async () => {
      throw new Error("not used");
    },
    get: () => ok(meta),
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([meta]),
    listByInvocation: () => ok([meta]),
    readRange: async (artifact, offset, length) =>
      ok({
        artifactId: artifact,
        offset,
        byteLength: Math.min(length, bytes.byteLength - offset),
        bytes: bytes.slice(offset, offset + length),
        endOfArtifact: offset + length >= bytes.byteLength,
      }),
    preview: async (artifact, maximumBytes) =>
      ok({
        artifactId: artifact,
        offset: 0,
        byteLength: Math.min(maximumBytes, bytes.byteLength),
        bytes: bytes.slice(0, maximumBytes),
        endOfArtifact: maximumBytes >= bytes.byteLength,
      }),
    sweep: async () => ({
      examined: 0,
      deleted: 0,
      retained: [],
      failed: 0,
      completeness: "complete",
      effect: "none",
    }),
    ...overrides,
  };
}

describe("the artifact viewer", () => {
  test("views identity text without transforming it", async () => {
    const viewed = await createArtifactViewer(store(new TextEncoder().encode("hello world"))).view({
      artifactId: "view-1",
    });
    expect(viewed.ok && viewed.value.status).toBe("complete");
    expect(viewed.ok && viewed.value.transformed).toBe(false);
    expect(viewed.ok && viewed.value.body).toMatchObject({ kind: "document", text: "hello world" });
  });

  test("expands gzip under the decoded-byte ceiling", async () => {
    const plain = new TextEncoder().encode("hello gzip");
    const compressed = gzipSync(plain);
    const viewed = await createArtifactViewer(
      store(compressed, record({ encoding: "gzip", byteLength: compressed.byteLength })),
    ).view({ artifactId: "view-1" });
    expect(viewed.ok && viewed.value.status).toBe("transformed");
    expect(viewed.ok && viewed.value.transformed).toBe(true);
    expect(viewed.ok && viewed.value.body).toMatchObject({ kind: "document", text: "hello gzip" });
  });

  test("refuses a gzip bomb instead of expanding it", async () => {
    const compressed = gzipSync(new Uint8Array(64 * 1024));
    const viewed = await createArtifactViewer(
      store(compressed, record({ encoding: "gzip", byteLength: compressed.byteLength })),
    ).view({
      artifactId: "view-1",
      limits: { maxDecodedBytes: 16, maxDecompressionRatio: 2 },
    });
    expect(viewed.ok).toBe(false);
    expect(viewed.ok || viewed.error).toMatchObject({
      kind: "artifact-view",
      code: "decompression-limit",
    });
  });

  test("refuses gzip that is not gzip", async () => {
    const viewed = await createArtifactViewer(
      store(new TextEncoder().encode("not gzip"), record({ encoding: "gzip", byteLength: 8 })),
    ).view({ artifactId: "view-1" });
    expect(viewed.ok).toBe(false);
    expect(viewed.ok || viewed.error).toMatchObject({
      kind: "artifact-view",
      code: "malformed-encoding",
    });
  });

  test("redacts restricted artifacts without reading bytes", async () => {
    let reads = 0;
    const viewed = await createArtifactViewer(
      store(new TextEncoder().encode("secret"), record({ sensitivity: "restricted" }), {
        preview: async () => {
          reads += 1;
          throw new Error("restricted must not read");
        },
        verifyIntegrity: async () => {
          reads += 1;
          throw new Error("restricted must not hash");
        },
      }),
    ).view({ artifactId: "view-1" });
    expect(reads).toBe(0);
    expect(viewed.ok && viewed.value.status).toBe("redacted");
    expect(viewed.ok && viewed.value.body).toBeNull();
  });

  test("reports quarantined without reading unavailable bytes", async () => {
    const viewed = await createArtifactViewer(
      store(new TextEncoder().encode("broken"), record({ availability: "quarantined" }), {
        preview: async () => {
          throw new Error("quarantined must not read through the available path");
        },
      }),
    ).view({ artifactId: "view-1" });
    expect(viewed.ok && viewed.value.status).toBe("quarantined");
    expect(viewed.ok && viewed.value.body).toBeNull();
  });

  test("marks a digest mismatch stale and still shows the body", async () => {
    const viewed = await createArtifactViewer(
      store(new TextEncoder().encode("hello world"), record(), {
        verifyIntegrity: async () => ok(false),
      }),
    ).view({ artifactId: "view-1" });
    expect(viewed.ok && viewed.value.status).toBe("stale");
    expect(viewed.ok && viewed.value.body).toMatchObject({ text: "hello world" });
  });

  test("honours cancellation before the store is touched", async () => {
    const viewed = await createArtifactViewer(store(new TextEncoder().encode("hello"))).view(
      { artifactId: "view-1" },
      AbortSignal.abort(),
    );
    expect(viewed.ok).toBe(false);
    expect(viewed.ok || viewed.error).toMatchObject({ code: "cancelled" });
  });

  test("does not execute a notebook or image as a side effect of viewing", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const viewed = await createArtifactViewer(
      store(bytes, record({ mediaType: "image/png", byteLength: bytes.byteLength })),
    ).view({ artifactId: "view-1" });
    expect(viewed.ok && viewed.value.kind).toBe("media");
    expect(viewed.ok && viewed.value.body).toMatchObject({ kind: "media", visual: "summary" });
  });
});
