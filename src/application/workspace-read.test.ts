import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type ArtifactStorePort,
  artifactId,
  contentDigest,
  createInMemoryFileSystem,
  localPath,
  ok,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

function reader() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "one\ntwo\nthree\n" },
      "/work/project/src/b.ts": { kind: "file", text: "bbb" },
      "/work/project/src/alias.ts": { kind: "symlink", target: "/work/project/src/a.ts" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/work/project/secret.bin": { kind: "file", text: "sk-live-SECRET\0" },
      "/work/project/binary.pdf": {
        kind: "file",
        bytes: Uint8Array.from([37, 80, 68, 70, 0, 255]),
      },
      "/work/project/huge.ts": { kind: "file", text: "0123456789abcdef" },
      "/etc/passwd": { kind: "file", text: "root" },
    },
  });
  return createWorkspaceReader(fs);
}

function expansionStore(captured: { bytes: Uint8Array | null }): ArtifactStorePort {
  return {
    async ingest(request) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.content) {
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      captured.bytes = bytes;
      const hash = createHash("sha256");
      hash.update(bytes);
      return ok({
        record: {
          artifactId: request.artifactId,
          digest: contentDigest.from(`sha-256:${hash.digest("hex")}`),
          mediaType: request.mediaType,
          encoding: request.encoding,
          byteLength: request.declaredByteLength,
          sensitivity: request.sensitivity,
          origin: request.origin,
          invocationId: request.invocationId,
          createdAt: timestampFromEpochMilliseconds(0),
          finalizedAt: timestampFromEpochMilliseconds(1),
          availability: "available",
        },
        deduplicated: false,
        cancelledAfterCommit: false,
      });
    },
    get: () => ok(null),
    findByDigest: () => ok([]),
    listByInvocation: () => ok([]),
    readRange: async () => ({
      ok: false,
      error: {
        kind: "artifact",
        code: "not-found",
        artifactId: artifactId.from("unused"),
      },
    }),
    preview: async () => ({
      ok: false,
      error: {
        kind: "artifact",
        code: "not-found",
        artifactId: artifactId.from("unused"),
      },
    }),
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

describe("createWorkspaceReader", () => {
  test("reads numbered text for one file", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/a.ts");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines).toEqual([
      { number: 1, text: "one" },
      { number: 2, text: "two" },
      { number: 3, text: "three" },
    ]);
    expect(read.value.newline).toBe("lf");
  });

  test("applies a line range", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/a.ts", {
      kind: "line",
      range: { start: 2, end: 2 },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines).toEqual([{ number: 2, text: "two" }]);
    expect(read.value.truncated).toBe(true);
  });

  test("follows an in-workspace symlink to file bytes", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/alias.ts");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines[0]?.text).toBe("one");
    expect(read.value.bound.logical).toBe("src/a.ts");
  });

  test("refuses a symlink that leaves the root", async () => {
    const workspace = reader();
    expect(await workspace.read(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("refuses a directory", async () => {
    const workspace = reader();
    expect(await workspace.read(root, "src")).toEqual({
      ok: false,
      error: { code: "not-a-file" },
    });
  });

  test("refuses binary content without echoing secrets", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "secret.bin");
    expect(read).toEqual({ ok: false, error: { code: "binary" } });
    expect(JSON.stringify(read)).not.toContain("sk-live-SECRET");
  });

  test("reads bounded binary bytes without coercing them to text", async () => {
    const workspace = reader();
    const read = await workspace.readBytes(root, "binary.pdf");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected binary read");
    }
    expect([...read.value.bytes]).toEqual([37, 80, 68, 70, 0, 255]);
    expect(read.value.byteLength).toBe(6);
  });

  test("refuses an oversized file without returning bytes", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "huge.ts", undefined, { maxFileBytes: 4 });
    expect(read.ok).toBe(false);
    if (read.ok) {
      throw new Error("expected oversized");
    }
    expect(read.error.code).toBe("oversized");
    expect(JSON.stringify(read)).not.toContain("0123456789abcdef");
  });

  test("reads many files in input order", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/b.ts" }, { path: "src/a.ts" }], {
      maxConcurrency: 2,
    });
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items.map((item) => item.index)).toEqual([0, 1]);
    expect(many.value.items[0]?.status).toBe("read");
    expect(many.value.items[1]?.status).toBe("read");
  });

  test("reuses one canonical read for aliases", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/a.ts" }, { path: "src/alias.ts" }]);
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items.every((item) => item.status === "read")).toBe(true);
  });

  test("leaves later targets unscheduled when the aggregate budget is spent", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/a.ts" }, { path: "src/b.ts" }], {
      maxAggregateBytes: 14,
      maxConcurrency: 1,
    });
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items[0]?.status).toBe("read");
    expect(many.value.items[1]?.status).toBe("unscheduled");
  });

  test("honors cancellation", async () => {
    const workspace = reader();
    expect(
      await workspace.read(root, "src/a.ts", undefined, undefined, AbortSignal.abort()),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("preserves exact source metadata for a complete text read", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/a.ts");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected complete read");
    }
    expect(read.value).toMatchObject({
      requestedTarget: "src/a.ts",
      resolvedTarget: "/work/project/src/a.ts",
      sourceIdentity: "/work/project/src/a.ts",
      completeness: "complete",
      fidelity: "exact",
      encoding: "utf-8",
      newline: "lf",
      actualRange: null,
      continuation: null,
      expansion: null,
      diagnostics: [],
    });
    expect(read.value.digest).toMatch(/^sha-256:[0-9a-f]{64}$/);
    expect(read.value.inlineByteLength).toBe(read.value.byteLength);
    expect(read.value.revision).toBeTruthy();
  });

  test("decodes BOM text while hashing the original bytes", async () => {
    const bytes = Uint8Array.from([
      0xff, 0xfe, 0x6f, 0x00, 0x6e, 0x00, 0x65, 0x00, 0x0a, 0x00, 0x74, 0x00, 0x77, 0x00, 0x6f,
      0x00,
    ]);
    const workspace = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/utf16.txt": { kind: "file", bytes },
        },
      }),
    );
    const read = await workspace.read(root, "utf16.txt");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected UTF-16 read");
    }
    expect(read.value.encoding).toBe("utf-16le");
    expect(read.value.lines).toEqual([
      { number: 1, text: "one" },
      { number: 2, text: "two" },
    ]);
    expect(read.value.digest).toBe(
      contentDigest.from(`sha-256:${createHash("sha256").update(bytes).digest("hex")}`),
    );
  });

  test("decodes UTF-16 byte ranges using the source encoding", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x6f, 0x00, 0x6e, 0x00, 0x65, 0x00]);
    const workspace = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/utf16.txt": { kind: "file", bytes },
        },
      }),
    );
    const read = await workspace.read(root, "utf16.txt", {
      kind: "byte",
      range: { start: 2, end: bytes.byteLength },
    });

    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected UTF-16 byte-range read");
    }
    expect(read.value.lines).toEqual([{ number: 1, text: "one" }]);
    expect(read.value.actualRange).toEqual({
      kind: "byte",
      range: { start: 2, end: bytes.byteLength },
    });
  });

  test("returns bounded inline source with a durable expansion", async () => {
    const source = new TextEncoder().encode("one\ntwo\nthree\nfour");
    const captured = { bytes: null as Uint8Array | null };
    const workspace = createWorkspaceReader(
      createInMemoryFileSystem({
        nodes: {
          "/work/project": { kind: "directory" },
          "/work/project/large.txt": { kind: "file", bytes: source },
        },
      }),
      { artifacts: expansionStore(captured) },
    );
    const read = await workspace.read(root, "large.txt", undefined, {
      maxFileBytes: 7,
      maxExpansionBytes: source.byteLength,
      maxExpansionChunkBytes: 3,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected expanded read");
    }
    expect(read.value.completeness).toBe("partial");
    expect(read.value.lines).toEqual([
      { number: 1, text: "one" },
      { number: 2, text: "two" },
    ]);
    expect(read.value.expansion).toMatchObject({
      kind: "artifact",
      byteLength: source.byteLength,
      mediaType: "text/plain",
    });
    expect(read.value.continuation).toEqual({
      kind: "byte",
      offset: 7,
      length: source.byteLength - 7,
      reason: "inline-limit",
    });
    expect(read.value.diagnostics).toEqual([
      {
        code: "inline-limit",
        returnedBytes: 7,
        sourceBytes: source.byteLength,
      },
    ]);
    expect(captured.bytes).toEqual(source);
    expect(read.value.digest).toBe(
      contentDigest.from(`sha-256:${createHash("sha256").update(source).digest("hex")}`),
    );
  });

  test("rejects invalid read limits instead of clamping them", async () => {
    const workspace = reader();
    expect(await workspace.read(root, "src/a.ts", undefined, { maxFileBytes: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxFileBytes", reason: "not-positive" },
    });
  });

  test("reports a source that changes during a read as stale", async () => {
    const base = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/source.ts": { kind: "file", text: "stable", revision: "before" },
      },
    });
    let statCalls = 0;
    const changing = {
      ...base,
      stat: async (path: Parameters<typeof base.stat>[0], signal?: AbortSignal) => {
        const result = await base.stat(path, signal);
        statCalls += 1;
        if (result.ok && result.value !== null && statCalls >= 2) {
          return { ok: true as const, value: { ...result.value, revision: "after" } };
        }
        return result;
      },
    };
    const workspace = createWorkspaceReader(changing);
    expect(await workspace.read(root, "source.ts", undefined, { maxStaleRetries: 0 })).toEqual({
      ok: false,
      error: { code: "stale", attempts: 1 },
    });
  });
});
