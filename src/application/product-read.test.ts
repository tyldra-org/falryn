/** Product Read orchestration with one-copy Loom recovery (#814). */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactIngestRequest,
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
  buildIndexGeneration,
  CONTENT_DIGEST_ALGORITHM,
  configurationGeneration,
  contentDigest,
  createInMemoryFileSystem,
  createInMemoryWorkspaceIndex,
  localPath,
  timestampFromEpochMilliseconds,
  type WorkspaceFileRead,
  type WorkspaceIndexPort,
} from "../domain/index.ts";
import { err, ok } from "../domain/result.ts";
import { createLoomPort, type LoomPort } from "./loom.ts";
import { createProductReadCoordinator, productReadInputSchema } from "./product-read.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

function digestOf(bytes: Uint8Array): ReturnType<typeof contentDigest.from> {
  return contentDigest.from(
    `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`,
  );
}

function memoryArtifacts(): ArtifactStorePort & {
  readonly ingests: string[];
  readonly reads: Array<{ readonly offset: number; readonly length: number }>;
} {
  const bytesById = new Map<string, Uint8Array>();
  const records = new Map<string, ArtifactRecord>();
  const ingests: string[] = [];
  const reads: Array<{ offset: number; length: number }> = [];
  return {
    ingests,
    reads,
    async ingest(request: ArtifactIngestRequest) {
      ingests.push(request.artifactId);
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      for await (const chunk of request.content) {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const record: ArtifactRecord = {
        artifactId: request.artifactId,
        digest: digestOf(bytes),
        mediaType: request.mediaType,
        encoding: request.encoding,
        byteLength,
        sensitivity: request.sensitivity,
        origin: request.origin,
        invocationId: request.invocationId,
        createdAt: timestampFromEpochMilliseconds(0),
        finalizedAt: timestampFromEpochMilliseconds(0),
        availability: "available",
      };
      bytesById.set(request.artifactId, bytes);
      records.set(request.artifactId, record);
      return ok({ record, deduplicated: false, cancelledAfterCommit: false });
    },
    get(id) {
      return ok(records.get(id) ?? null);
    },
    verifyIntegrity: async () => ok(true),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    async readRange(id, offset, length) {
      reads.push({ offset, length });
      const bytes = bytesById.get(id);
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

describe("createProductReadCoordinator", () => {
  test("uses current index structure for a line-aware Loom projection", async () => {
    const lines = Array.from({ length: 160 }, (_, index) => `const value${index + 1} = ${index};`);
    lines[0] = "export const first = 1;";
    lines[9] = 'export const apiKey = "sk-live-SECRET-MUST-NOT-ESCAPE";';
    lines[79] = "export function composeIndexedContext() { return first; }";
    lines[159] = "export class FinalBoundary {}";
    const source = lines.join("\n");
    const digest = digestOf(new TextEncoder().encode(source));
    const built = buildIndexGeneration(
      { sources: [{ logical: "src/large.ts", revision: String(digest), text: source }] },
      "generation-current",
    );
    if (!built.ok) {
      throw new Error(built.error.code);
    }
    const artifacts = memoryArtifacts();
    const reader = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/src": { kind: "directory" },
          "/work/project/src/large.ts": { kind: "file", text: source },
        },
      }),
      { artifacts },
    );
    const coordinator = createProductReadCoordinator({
      reader,
      loom: createLoomPort({ artifacts }),
      index: createInMemoryWorkspaceIndex(built.value.generation),
      workspaceRoot: localPath("/work/project"),
      workspaceId: "ws-1",
      sessionId: "session-1",
      generation: configurationGeneration.from(1),
    });

    const initial = await coordinator.execute(
      {
        path: "src/large.ts",
        limits: {
          maxFileBytes: 16,
          maxExpansionBytes: 20_000,
          maxExpansionChunkBytes: 1_024,
        },
      },
      new AbortController().signal,
    );
    if (!initial.ok) {
      throw new Error(initial.error);
    }
    const payload = initial.value as {
      readonly content: string;
      readonly projection: { readonly kind: string; readonly indexGeneration: string };
      readonly loomRecovery: { readonly origin: string; readonly artifactId: string };
    };
    expect(payload.projection).toMatchObject({
      kind: "indexed-outline",
      indexGeneration: "generation-current",
    });
    expect(payload.content).toContain("80 | export function composeIndexedContext()");
    expect(payload.content).toMatch(/lines \d+-79 omitted/);
    expect(payload.content).toContain("apiKey=[redacted]");
    expect(payload.content).not.toContain("sk-live-SECRET");
    expect(payload.loomRecovery.origin).toBe("src/large.ts");
    expect(artifacts.ingests).toHaveLength(1);
    expect(artifacts.reads).toHaveLength(0);

    const candidate = coordinator.candidates()[0];
    expect(candidate).toMatchObject({
      sourceKind: "file",
      origin: "src/large.ts",
      freshness: "indexed",
      fidelity: "deterministic-transform",
    });
    expect(candidate?.expansion?.kind).toBe("artifact");

    expect(
      await coordinator.execute(
        {
          recovery: { ...payload.loomRecovery, origin: "src/other.ts" },
          projection: { kind: "range", offset: 0, length: 64, maxBytes: 64 },
        },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, error: "loom-origin-mismatch" });
    expect(artifacts.reads).toHaveLength(0);

    const recovered = await coordinator.execute(
      {
        recovery: payload.loomRecovery,
        projection: { kind: "range", offset: 0, length: 64, maxBytes: 64 },
      },
      new AbortController().signal,
    );
    expect(recovered.ok).toBe(true);
    expect(artifacts.reads).toHaveLength(1);
    expect(coordinator.candidates()[1]).toMatchObject({
      sourceKind: "file",
      origin: "src/large.ts",
    });
  });

  test("retains one exact artifact and recovers targeted Loom projections", async () => {
    const source = `${"a".repeat(5_000)}needle${"z".repeat(5_000)}`;
    const artifacts = memoryArtifacts();
    const reader = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/large.txt": { kind: "file", text: source },
        },
      }),
      { artifacts },
    );
    const coordinator = createProductReadCoordinator({
      reader,
      loom: createLoomPort({ artifacts }),
      workspaceRoot: localPath("/work/project"),
      workspaceId: "ws-1",
      sessionId: "session-1",
      generation: configurationGeneration.from(1),
    });

    const initial = await coordinator.execute(
      {
        path: "large.txt",
        limits: {
          maxFileBytes: 16,
          maxExpansionBytes: 20_000,
          maxExpansionChunkBytes: 1_024,
        },
      },
      new AbortController().signal,
    );
    expect(initial.ok).toBe(true);
    if (!initial.ok) {
      return;
    }
    const payload = initial.value as {
      readonly content: string;
      readonly loomRecovery: { readonly manifestId: string; readonly artifactId: string };
    };
    expect(payload.content.startsWith("a".repeat(2_048))).toBe(true);
    expect(payload.content).toContain("5910 bytes omitted");
    expect(payload.content.endsWith("z".repeat(2_048))).toBe(true);
    const handle = structuredClone(payload.loomRecovery);
    expect(handle.manifestId.startsWith("loom-read-")).toBe(true);
    expect(typeof handle.artifactId).toBe("string");
    expect(artifacts.ingests).toHaveLength(1);
    expect(artifacts.reads).toHaveLength(2);
    expect(coordinator.candidates()).toHaveLength(1);

    const recoveryInput = {
      recovery: handle,
      projection: {
        kind: "search-hits" as const,
        query: "needle",
        maxHits: 1,
        contextBytes: 4,
        maxBytes: 64,
      },
    };
    const parsedRecovery = productReadInputSchema.safeParse(recoveryInput);
    if (!parsedRecovery.success) {
      throw new Error(JSON.stringify(parsedRecovery.error.issues));
    }

    const targeted = await coordinator.execute(recoveryInput, new AbortController().signal);
    if (!targeted.ok) {
      throw new Error(targeted.error);
    }
    expect(targeted.ok).toBe(true);
    expect(targeted.value).toMatchObject({ content: "aaaaneedlezzzz" });
    expect(artifacts.ingests).toHaveLength(1);
    expect(coordinator.candidates()).toHaveLength(2);

    const readsAfterFirstRecovery = artifacts.reads.length;
    const repeated = await coordinator.execute(
      {
        recovery: payload.loomRecovery,
        projection: {
          kind: "search-hits",
          query: "needle",
          maxHits: 1,
          contextBytes: 4,
          maxBytes: 64,
        },
      },
      new AbortController().signal,
    );
    expect(repeated).toEqual(targeted);
    expect(artifacts.reads).toHaveLength(readsAfterFirstRecovery);
  });

  test("raw mode bypasses indexed and Loom projection for single and multi reads", async () => {
    const firstSource = Array.from(
      { length: 80 },
      (_, index) => `export const first${index + 1} = ${index};`,
    ).join("\n");
    const secondSource = Array.from(
      { length: 80 },
      (_, index) => `export const second${index + 1} = ${index};`,
    ).join("\n");
    const built = buildIndexGeneration(
      {
        sources: [
          {
            logical: "src/first.ts",
            revision: String(digestOf(new TextEncoder().encode(firstSource))),
            text: firstSource,
          },
          {
            logical: "src/second.ts",
            revision: String(digestOf(new TextEncoder().encode(secondSource))),
            text: secondSource,
          },
        ],
      },
      "generation-current",
    );
    if (!built.ok) {
      throw new Error(built.error.code);
    }
    const artifacts = memoryArtifacts();
    const reader = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/src": { kind: "directory" },
          "/work/project/src/first.ts": { kind: "file", text: firstSource },
          "/work/project/src/second.ts": { kind: "file", text: secondSource },
        },
      }),
      { artifacts },
    );
    let adoptionCount = 0;
    const baseLoom = createLoomPort({ artifacts });
    const loom: LoomPort = {
      ...baseLoom,
      async adopt(request, signal) {
        adoptionCount += 1;
        return baseLoom.adopt(request, signal);
      },
    };
    let snapshotCount = 0;
    const baseIndex = createInMemoryWorkspaceIndex(built.value.generation);
    const index: WorkspaceIndexPort = {
      async snapshot(root, signal) {
        snapshotCount += 1;
        return baseIndex.snapshot(root, signal);
      },
    };
    const coordinator = createProductReadCoordinator({
      reader,
      loom,
      index,
      workspaceRoot: localPath("/work/project"),
      workspaceId: "ws-1",
      sessionId: "session-1",
      generation: configurationGeneration.from(1),
    });
    const limits = {
      maxFileBytes: 64,
      maxAggregateBytes: 256,
      maxExpansionBytes: 20_000,
      maxExpansionChunkBytes: 1_024,
    };

    const raw = await coordinator.execute(
      { path: "src/first.ts", outputMode: "raw", limits },
      new AbortController().signal,
    );
    if (!raw.ok) {
      throw new Error(raw.error);
    }
    const rawValue = raw.value as WorkspaceFileRead;
    expect(rawValue.fidelity).toBe("exact");
    expect(rawValue.completeness).toBe("partial");
    expect(rawValue.inlineByteLength).toBeLessThan(rawValue.byteLength);
    expect(rawValue.continuation).not.toBeNull();
    expect(rawValue.expansion?.kind).toBe("artifact");
    expect("content" in rawValue).toBe(false);
    expect("loomRecovery" in rawValue).toBe(false);

    const many = await coordinator.execute(
      {
        targets: [{ path: "src/first.ts" }, { path: "src/second.ts" }],
        outputMode: "raw",
        limits,
      },
      new AbortController().signal,
    );
    if (!many.ok) {
      throw new Error(many.error);
    }
    const manyValue = many.value as {
      readonly items: ReadonlyArray<{
        readonly status: string;
        readonly value?: WorkspaceFileRead;
      }>;
    };
    expect(manyValue.items).toHaveLength(2);
    expect(manyValue.items.every((item) => item.status === "read")).toBe(true);
    expect(manyValue.items.every((item) => item.value?.fidelity === "exact")).toBe(true);
    expect(manyValue.items.every((item) => item.value?.expansion?.kind === "artifact")).toBe(true);
    expect(adoptionCount).toBe(0);
    expect(snapshotCount).toBe(0);
    expect(artifacts.reads).toEqual([]);
    expect(coordinator.candidates()).toEqual([]);

    const projected = await coordinator.execute(
      { path: "src/first.ts", outputMode: "loom", limits },
      new AbortController().signal,
    );
    if (!projected.ok) {
      throw new Error(projected.error);
    }
    expect(projected.value).toMatchObject({
      projection: { kind: "indexed-outline", indexGeneration: "generation-current" },
    });
    expect(adoptionCount).toBe(1);
    expect(snapshotCount).toBe(1);
    expect(coordinator.candidates()).toHaveLength(1);

    const defaultMode = productReadInputSchema.safeParse({ path: "src/first.ts" });
    expect(defaultMode.success).toBe(true);
    if (defaultMode.success) {
      expect(defaultMode.data).toMatchObject({ outputMode: "loom" });
    }
  });

  test("keeps small exact reads inline and rejects malformed recovery input", async () => {
    const artifacts = memoryArtifacts();
    const reader = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/small.txt": { kind: "file", text: "small\n" },
        },
      }),
      { artifacts },
    );
    const coordinator = createProductReadCoordinator({
      reader,
      loom: createLoomPort({ artifacts }),
      workspaceRoot: localPath("/work/project"),
      workspaceId: "ws-1",
      sessionId: "session-1",
      generation: configurationGeneration.from(1),
    });

    const small = await coordinator.execute({ path: "small.txt" }, new AbortController().signal);
    expect(small.ok).toBe(true);
    expect(artifacts.ingests).toEqual([]);
    expect(artifacts.reads).toEqual([]);
    expect(coordinator.candidates()).toEqual([]);

    expect(
      await coordinator.execute(
        { recovery: { manifestId: "loom-1" }, projection: { kind: "exact" } },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, error: "malformed-input" });
  });
});
