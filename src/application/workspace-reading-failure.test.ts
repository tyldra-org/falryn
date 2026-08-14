/**
 * Cross-reader failure matrix for workspace reading (#60).
 *
 * Covers malformed, stale, binary, large-file, symlink, and cancellation
 * outcomes on the shared path/list/read seams and through specialized readers.
 * Search, patch rollback, and product tool registration remain later owners.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type ArtifactStorePort,
  artifactId,
  contentDigest,
  createInMemoryFileSystem,
  type FileSystemPort,
  localPath,
  MAX_READ_MANY_TARGETS,
  ok,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { createCompactDocumentReader } from "./compact-document-read.ts";
import { createImageReader } from "./image-read.ts";
import { createNotebookReader } from "./notebook-read.ts";
import { createPdfReader } from "./pdf-read.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";
import { createWorkspacePathBinder } from "./workspace-path.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");
const SECRET = "sk-live-SECRET";

function nodes() {
  return {
    "/work/project": { kind: "directory" as const },
    "/work/project/src": { kind: "directory" as const },
    "/work/project/src/a.ts": { kind: "file" as const, text: "one\n" },
    "/work/project/src/b.ts": { kind: "file" as const, text: "two\n" },
    "/work/project/src/alias.ts": {
      kind: "symlink" as const,
      target: "/work/project/src/a.ts",
    },
    "/work/project/out": { kind: "symlink" as const, target: "/etc/passwd" },
    "/work/project/out.pdf": { kind: "symlink" as const, target: "/etc/passwd" },
    "/work/project/out.ipynb": { kind: "symlink" as const, target: "/etc/passwd" },
    "/work/project/secret.bin": { kind: "file" as const, text: `${SECRET}\0` },
    "/work/project/huge.ts": { kind: "file" as const, text: "0123456789abcdef" },
    "/work/project/broken.txt": { kind: "file" as const, bytes: Uint8Array.from([0xc3, 0x28]) },
    "/work/project/note.md": { kind: "file" as const, text: "# Title\nbody\n" },
    "/work/project/notebook.ipynb": {
      kind: "file" as const,
      text: '{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[]}',
    },
    "/etc/passwd": { kind: "file" as const, text: "root" },
  };
}

function fileSystem(): FileSystemPort & ReturnType<typeof createInMemoryFileSystem> {
  return createInMemoryFileSystem({ nodes: nodes() });
}

function reader(fs: FileSystemPort = fileSystem()) {
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
      error: { kind: "artifact", code: "not-found", artifactId: artifactId.from("unused") },
    }),
    preview: async () => ({
      ok: false,
      error: { kind: "artifact", code: "not-found", artifactId: artifactId.from("unused") },
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

describe("workspace reading failure matrix", () => {
  test("refuses malformed paths, encodings, ranges, limits, and oversized batches", async () => {
    const workspace = reader();
    const secretPath = await workspace.read(root, `src/${SECRET}\0.ts`);
    expect(secretPath.ok).toBe(false);
    if (secretPath.ok) {
      throw new Error("expected malformed path");
    }
    expect(secretPath.error.code).toBe("malformed");
    expect(JSON.stringify(secretPath)).not.toContain(SECRET);

    expect(await workspace.read(root, "broken.txt")).toEqual({
      ok: false,
      error: { code: "malformed-encoding" },
    });
    expect(
      await workspace.read(root, "src/a.ts", { kind: "line", range: { start: 3, end: 1 } }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-range" },
    });
    expect(await workspace.read(root, "src/a.ts", undefined, { maxFileBytes: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxFileBytes", reason: "not-positive" },
    });
    expect(
      await workspace.readMany(
        root,
        Array.from({ length: MAX_READ_MANY_TARGETS + 1 }, () => ({ path: "src/a.ts" })),
      ),
    ).toEqual({
      ok: false,
      error: { code: "too-many-targets" },
    });
  });

  test("reports stale text and binary reads when the source revision changes", async () => {
    const base = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/source.ts": { kind: "file", text: "stable", revision: "before" },
        "/work/project/blob.bin": {
          kind: "file",
          bytes: Uint8Array.from([1, 2, 3]),
          revision: "before",
        },
      },
    });
    let textStats = 0;
    let byteStats = 0;
    const changing: FileSystemPort = {
      ...base,
      stat: async (path, signal) => {
        const result = await base.stat(path, signal);
        if (path.endsWith("source.ts")) {
          textStats += 1;
          if (result.ok && result.value !== null && textStats >= 2) {
            return { ok: true, value: { ...result.value, revision: "after" } };
          }
        }
        if (path.endsWith("blob.bin")) {
          byteStats += 1;
          if (result.ok && result.value !== null && byteStats >= 2) {
            return { ok: true, value: { ...result.value, revision: "after" } };
          }
        }
        return result;
      },
    };
    const workspace = createWorkspaceReader(changing);
    expect(await workspace.read(root, "source.ts", undefined, { maxStaleRetries: 0 })).toEqual({
      ok: false,
      error: { code: "stale", attempts: 1 },
    });
    expect(await workspace.readBytes(root, "blob.bin", { maxStaleRetries: 0 })).toEqual({
      ok: false,
      error: { code: "stale", attempts: 1 },
    });
  });

  test("refuses binary text without echoing secrets and keeps exact binary bytes", async () => {
    const workspace = reader();
    const text = await workspace.read(root, "secret.bin");
    expect(text).toEqual({ ok: false, error: { code: "binary" } });
    expect(JSON.stringify(text)).not.toContain(SECRET);

    const bytes = await workspace.readBytes(root, "secret.bin");
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) {
      throw new Error("expected binary bytes");
    }
    expect(bytes.value.encoding).toBe("binary");
    expect(bytes.value.bytes.includes(0)).toBe(true);
  });

  test("bounds large files and expands exact source only when asked", async () => {
    const workspace = reader();
    const refused = await workspace.read(root, "huge.ts", undefined, { maxFileBytes: 4 });
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      throw new Error("expected oversized");
    }
    expect(refused.error.code).toBe("oversized");
    expect(JSON.stringify(refused)).not.toContain("0123456789abcdef");

    const captured = { bytes: null as Uint8Array | null };
    const expanded = await createWorkspaceReader(fileSystem(), {
      artifacts: expansionStore(captured),
    }).read(root, "huge.ts", undefined, {
      maxFileBytes: 4,
      maxExpansionBytes: 16,
      maxExpansionChunkBytes: 4,
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) {
      throw new Error("expected expansion");
    }
    expect(expanded.value.completeness).toBe("partial");
    expect(expanded.value.expansion?.byteLength).toBe(16);
    expect(captured.bytes).toEqual(new TextEncoder().encode("0123456789abcdef"));
  });

  test("follows in-workspace symlinks and refuses escapes on bind, list, and read", async () => {
    const fs = fileSystem();
    const workspace = createWorkspaceReader(fs);
    const listing = createWorkspaceListing(fs);
    const binder = createWorkspacePathBinder(fs);

    const followed = await workspace.read(root, "src/alias.ts");
    expect(followed.ok).toBe(true);
    if (!followed.ok) {
      throw new Error("expected symlink follow");
    }
    expect(followed.value.bound.logical).toBe("src/a.ts");

    expect(await binder.bind(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(await listing.stat(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(await workspace.read(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(JSON.stringify(await workspace.read(root, "out"))).not.toContain("root");
  });

  test("cancels bind, list, read, and later readMany targets without dropping completed items", async () => {
    const fs = fileSystem();
    const cancelled = AbortSignal.abort();
    expect(await createWorkspacePathBinder(fs).bind(root, "src/a.ts", cancelled)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await createWorkspaceListing(fs).list(root, "src", undefined, cancelled)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(
      await createWorkspaceReader(fs).read(root, "src/a.ts", undefined, undefined, cancelled),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });

    const controller = new AbortController();
    const aborting: FileSystemPort = {
      ...fs,
      stat: async (path, signal) => {
        if (String(path).endsWith("/src/b.ts")) {
          controller.abort();
        }
        return fs.stat(path, signal);
      },
    };
    const many = await createWorkspaceReader(aborting).readMany(
      root,
      [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      { maxConcurrency: 1 },
      controller.signal,
    );
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected partial cancellation");
    }
    expect(many.value.items[0]?.status).toBe("read");
    expect(many.value.items[1]).toEqual({
      index: 1,
      status: "failed",
      error: { code: "cancelled" },
    });
  });

  test("specialized readers inherit symlink-escape and cancellation from the workspace reader", async () => {
    const workspace = reader();
    const compact = createCompactDocumentReader(workspace);
    const notebook = createNotebookReader(workspace);
    const pdf = createPdfReader(workspace);
    const image = createImageReader(workspace);
    const cancelled = AbortSignal.abort();

    expect(await compact.read(root, { path: "out", mode: "outline" })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(await notebook.read(root, { path: "out.ipynb", mode: "all" })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(
      await pdf.read(root, { path: "out.pdf", mode: "pages", pages: [{ start: 1, end: 1 }] }),
    ).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
    expect(await image.read(root, { path: "out" })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });

    expect(await compact.read(root, { path: "note.md", mode: "outline" }, cancelled)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await notebook.read(root, { path: "notebook.ipynb", mode: "all" }, cancelled)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(
      await pdf.read(
        root,
        { path: "out.pdf", mode: "pages", pages: [{ start: 1, end: 1 }] },
        cancelled,
      ),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await image.read(root, { path: "out" }, cancelled)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
