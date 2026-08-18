import { describe, expect, test } from "bun:test";

import {
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
  contentDigest,
  ok,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { createArtifactReader } from "./artifact-read.ts";

const id = artifactId.from("capture-1");
const digest = contentDigest.from(`sha-256:${"a".repeat(64)}`);
const record: ArtifactRecord = {
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
};

function store(overrides: Partial<ArtifactStorePort> = {}): ArtifactStorePort {
  const bytes = new TextEncoder().encode("hello world");
  return {
    ingest: async () => {
      throw new Error("not used");
    },
    get: () => ok(record),
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([record]),
    listByInvocation: () => ok([record]),
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

describe("artifact reader", () => {
  test("returns metadata without reading bytes", async () => {
    let reads = 0;
    const result = await createArtifactReader(
      store({
        preview: async () => {
          reads += 1;
          throw new Error("metadata must not read");
        },
        readRange: async () => {
          reads += 1;
          throw new Error("metadata must not read");
        },
      }),
    ).read({ artifactId: "capture-1", mode: "metadata" });

    expect(result.ok).toBe(true);
    expect(reads).toBe(0);
    expect(result.ok && result.value.record.digest).toBe(digest);
    expect(result.ok && result.value.range).toBeNull();
  });

  test("returns bounded previews and exact ranges", async () => {
    const reader = createArtifactReader(store());
    const preview = await reader.read({
      artifactId: "capture-1",
      mode: "preview",
      length: 5,
    });
    const range = await reader.read({
      artifactId: "capture-1",
      mode: "range",
      offset: 6,
      length: 5,
    });

    expect(preview.ok && new TextDecoder().decode(preview.value.range?.bytes)).toBe("hello");
    expect(range.ok && new TextDecoder().decode(range.value.range?.bytes)).toBe("world");
    expect(range.ok && range.value.range?.offset).toBe(6);
    expect(range.ok && range.value.record.artifactId).toBe(id);
  });

  test("rejects implicit or over-budget expansion", async () => {
    const reader = createArtifactReader(store());

    expect(await reader.read({ artifactId: "capture-1", mode: "range", length: 2 })).toEqual({
      ok: false,
      error: { code: "malformed-request", field: "offset" },
    });
    expect(
      await reader.read({
        artifactId: "capture-1",
        mode: "preview",
        length: 65 * 1024,
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxPreviewBytes" },
    });
  });

  test("keeps missing artifacts distinct from storage failures", async () => {
    const missing = await createArtifactReader(store({ get: () => ok(null) })).read({
      artifactId: "capture-1",
      mode: "metadata",
    });
    const failed = await createArtifactReader(
      store({
        get: () => ({ ok: false, error: { kind: "artifact", code: "not-found", artifactId: id } }),
      }),
    ).read({ artifactId: "capture-1", mode: "metadata" });

    expect(missing).toEqual({
      ok: false,
      error: { kind: "artifact", code: "not-found", artifactId: id },
    });
    expect(failed).toEqual({
      ok: false,
      error: { kind: "artifact", code: "not-found", artifactId: id },
    });
  });

  test("propagates cancellation without creating a byte result", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createArtifactReader(store()).read(
      { artifactId: "capture-1", mode: "range", offset: 0, length: 2 },
      controller.signal,
    );

    expect(result).toEqual({ ok: false, error: { code: "cancelled" } });
  });
});
