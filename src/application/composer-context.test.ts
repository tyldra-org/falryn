/**
 * Composer attachment resolution into evidence candidates (#278).
 */

import { describe, expect, test } from "bun:test";
import { createInMemoryFileSystem, localPath, MAX_EVIDENCE_INLINE_BYTES } from "../domain/index.ts";
import {
  admitComposerContext,
  createFileAttachmentProbe,
  digestBytes,
} from "./composer-context.ts";

const root = localPath("/work/project");
const encoder = new TextEncoder();

function payloads(entries: readonly [string, Uint8Array][] = []) {
  const stored = new Map(entries);
  return {
    put(id: string, bytes: Uint8Array) {
      stored.set(id, bytes);
    },
    get(id: string) {
      return stored.get(id) ?? null;
    },
  };
}

describe("createFileAttachmentProbe", () => {
  test("marks a missing path inaccessible and a ready file ready", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/src": { kind: "directory" },
        "/work/project/src/a.ts": { kind: "file", text: "export const ok = 1;\n" },
      },
    });
    const probe = createFileAttachmentProbe({ fileSystem: fs, workspace: root });
    expect(probe).not.toBeNull();
    if (probe === null) {
      return;
    }
    const missing = await probe.inspect("src/missing.ts");
    expect(missing.status).toBe("inaccessible");
    const ready = await probe.inspect("src/a.ts");
    expect(ready.status).toBe("ready");
    expect(ready.digest).toBe(digestBytes(encoder.encode("export const ok = 1;\n")));
  });

  test("refuses a symlink that leaves the workspace", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
        "/etc/passwd": { kind: "file", text: "x" },
      },
    });
    const probe = createFileAttachmentProbe({ fileSystem: fs, workspace: root });
    if (probe === null) {
      throw new Error("expected probe");
    }
    expect((await probe.inspect("out")).status).toBe("inaccessible");
  });
});

describe("admitComposerContext", () => {
  test("admits an included paste from the payload port", async () => {
    const text = "a held-out paste body\n";
    const bytes = encoder.encode(text);
    const store = payloads([["att-1", bytes]]);
    const result = await admitComposerContext(
      {
        attachments: [
          {
            id: "att-1",
            kind: "paste",
            identity: "paste:att-1",
            status: "ready",
            byteLength: bytes.byteLength,
            characters: text.length,
            lines: 2,
            digest: digestBytes(bytes),
            revision: null,
            mediaType: "text/plain",
            secret: false,
          },
        ],
        mentions: [],
        payloads: store,
      },
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidates[0]?.sourceKind).toBe("attachment");
    expect(
      result.candidates[0]?.payload.kind === "inline" && result.candidates[0].payload.text,
    ).toBe(text);
  });

  test("blocks an oversized paste rather than inlining it", async () => {
    const text = "x".repeat(MAX_EVIDENCE_INLINE_BYTES + 1);
    const bytes = encoder.encode(text);
    const store = payloads([["att-1", bytes]]);
    const result = await admitComposerContext(
      {
        attachments: [
          {
            id: "att-1",
            kind: "paste",
            identity: "paste:att-1",
            status: "oversized",
            byteLength: bytes.byteLength,
            characters: text.length,
            lines: 1,
            digest: digestBytes(bytes),
            revision: null,
            mediaType: "text/plain",
            secret: false,
          },
        ],
        mentions: [],
        payloads: store,
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("oversized");
  });

  test("resolves an @path mention through the probe", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/readme.md": { kind: "file", text: "# hi\n" },
      },
    });
    const probe = createFileAttachmentProbe({ fileSystem: fs, workspace: root });
    const result = await admitComposerContext(
      {
        attachments: [],
        mentions: [
          {
            start: 0,
            end: 11,
            raw: "@readme.md",
            kind: "file",
            identity: "readme.md",
          },
        ],
        payloads: payloads(),
      },
      probe,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidates[0]?.sourceKind).toBe("file");
    expect(result.candidates[0]?.origin).toBe("readme.md");
    expect(result.attachments[0]?.identity).toBe("readme.md");
    expect(result.attachments[0]?.status).toBe("ready");
  });

  test("projects a changed file after the digest moves", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/a.ts": { kind: "file", text: "one\n", revision: "1" },
      },
    });
    const probe = createFileAttachmentProbe({ fileSystem: fs, workspace: root });
    if (probe === null) {
      throw new Error("expected probe");
    }
    const first = await probe.inspect("a.ts");
    expect(first.status).toBe("ready");
    const updated = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/a.ts": { kind: "file", text: "two\n", revision: "2" },
      },
    });
    const later = createFileAttachmentProbe({ fileSystem: updated, workspace: root });
    if (later === null) {
      throw new Error("expected probe");
    }
    const second = await later.inspect("a.ts", first);
    expect(second.status).toBe("changed");
  });
});
