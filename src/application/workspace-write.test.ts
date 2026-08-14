import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  contentDigest,
  createInMemoryFileSystem,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import { createWorkspaceWriter } from "./workspace-write.ts";

const root = localPath("/work/project");

function writer(nodes: Record<string, InMemoryNode> = {}) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "one\n", revision: "rev-a" },
      "/work/project/src/dir": { kind: "directory" },
      "/work/project/link": { kind: "symlink", target: "/etc/passwd" },
      "/etc/passwd": { kind: "file", text: "root" },
      ...nodes,
    },
  });
  return { fileSystem, workspace: createWorkspaceWriter({ fileSystem }) };
}

function digestFor(text: string): string {
  return `sha-256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("createWorkspaceWriter", () => {
  test("creates a missing file and replaces an existing one", async () => {
    const { fileSystem, workspace } = writer();
    const created = await workspace.apply(root, {
      targets: [{ kind: "create", path: "src/b.ts", text: "two\n" }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected create");
    }
    expect(created.value.items).toMatchObject([
      {
        status: "applied",
        operation: "create",
        byteLength: 4,
        digest: contentDigest.from(digestFor("two\n")),
        changedRegion: { kind: "byte", range: { start: 0, end: 4 } },
      },
    ]);
    const read = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(read).toEqual({ ok: true, value: "two\n" });

    const replaced = await workspace.apply(root, {
      targets: [{ kind: "replace", path: "src/a.ts", text: "three\n" }],
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      throw new Error("expected replace");
    }
    expect(replaced.value.items[0]?.status).toBe("applied");
    const after = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    expect(after).toEqual({ ok: true, value: "three\n" });
  });

  test("creates missing parents for create", async () => {
    const { fileSystem, workspace } = writer();
    const result = await workspace.apply(root, {
      targets: [{ kind: "create", path: "src/new/nested.ts", text: "n\n" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected nested create");
    }
    expect(result.value.items[0]?.status).toBe("applied");
    const listed = await fileSystem.stat(localPath("/work/project/src/new"));
    expect(listed.ok && listed.value?.kind).toBe("directory");
  });

  test("fail-before-effect applies nothing when a later target is invalid", async () => {
    const { fileSystem, workspace } = writer();
    const result = await workspace.apply(root, {
      policy: "fail-before-effect",
      targets: [
        { kind: "create", path: "src/b.ts", text: "ok\n" },
        { kind: "create", path: "src/a.ts", text: "nope\n" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected plan result");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["unscheduled", "failed"]);
    expect(result.value.items[1]).toMatchObject({
      status: "failed",
      error: { code: "already-exists" },
    });
    const missing = await fileSystem.stat(localPath("/work/project/src/b.ts"));
    expect(missing.ok && missing.value).toBeNull();
  });

  test("best-effort skips a precondition failure and applies the rest", async () => {
    const { fileSystem, workspace } = writer();
    const result = await workspace.apply(root, {
      policy: "best-effort",
      targets: [
        { kind: "create", path: "src/a.ts", text: "nope\n" },
        { kind: "create", path: "src/b.ts", text: "ok\n" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected best-effort result");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["skipped", "applied"]);
    const created = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(created).toEqual({ ok: true, value: "ok\n" });
  });

  test("refuses replace when digest or revision does not match", async () => {
    const { workspace } = writer();
    const digest = await workspace.apply(root, {
      targets: [
        {
          kind: "replace",
          path: "src/a.ts",
          text: "x\n",
          expectedDigest: digestFor("wrong\n"),
        },
      ],
    });
    expect(digest).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "digest-mismatch" } }] },
    });
    const revision = await workspace.apply(root, {
      targets: [
        {
          kind: "replace",
          path: "src/a.ts",
          text: "x\n",
          expectedRevision: "stale",
        },
      ],
    });
    expect(revision).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "revision-mismatch" } }] },
    });
  });

  test("refuses directories, escaping symlinks, and never echoes secrets", async () => {
    const { workspace } = writer();
    const directory = await workspace.apply(root, {
      targets: [{ kind: "replace", path: "src/dir", text: "x" }],
    });
    expect(directory).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "not-a-file" } }] },
    });
    const escaped = await workspace.apply(root, {
      targets: [{ kind: "replace", path: "link", text: "x" }],
    });
    expect(escaped).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "symlink-escape" } }] },
    });
    expect(JSON.stringify(escaped)).not.toContain("root");
    const secret = await createWorkspaceWriter({
      fileSystem: createInMemoryFileSystem(),
    }).apply(root, {
      targets: [{ kind: "create", path: "secret.txt", text: "sk-live-SECRET\0" }],
    });
    expect(secret).toEqual({ ok: false, error: { code: "malformed-text" } });
    expect(JSON.stringify(secret)).not.toContain("sk-live-SECRET");
  });

  test("keeps applied targets when later work is cancelled", async () => {
    const { fileSystem } = writer();
    const controller = new AbortController();
    const aborting = {
      ...fileSystem,
      writeBytes: async (
        path: Parameters<typeof fileSystem.writeBytes>[0],
        bytes: Uint8Array,
        signal?: AbortSignal,
      ) => {
        const result = await fileSystem.writeBytes(path, bytes, signal);
        if (String(path).endsWith("/src/b.ts")) {
          controller.abort();
        }
        return result;
      },
    };
    const result = await createWorkspaceWriter({ fileSystem: aborting }).apply(
      root,
      {
        policy: "best-effort",
        targets: [
          { kind: "create", path: "src/b.ts", text: "kept\n" },
          { kind: "create", path: "src/c.ts", text: "later\n" },
        ],
      },
      controller.signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected cancelled remainder");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["applied", "cancelled"]);
    const kept = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(kept).toEqual({ ok: true, value: "kept\n" });
    const later = await fileSystem.stat(localPath("/work/project/src/c.ts"));
    expect(later.ok && later.value).toBeNull();
  });
});
