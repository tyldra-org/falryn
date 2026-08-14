import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  type FileSystemPort,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import { createWorkspaceMutator } from "./workspace-mutate.ts";

const root = localPath("/work/project");

function mutator(nodes: Record<string, InMemoryNode> = {}) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "one\n", revision: "rev-a" },
      "/work/project/src/nested": { kind: "directory" },
      "/work/project/src/nested/b.ts": { kind: "file", text: "two\n" },
      "/work/project/link": { kind: "symlink", target: "/etc/passwd" },
      "/etc/passwd": { kind: "file", text: "root" },
      ...nodes,
    },
  });
  return { fileSystem, workspace: createWorkspaceMutator({ fileSystem }) };
}

describe("createWorkspaceMutator", () => {
  test("moves a file by rename and copies one without removing the source", async () => {
    const { fileSystem, workspace } = mutator();
    const moved = await workspace.apply(root, {
      kind: "move",
      source: "src/a.ts",
      destination: "src/moved.ts",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) {
      throw new Error("expected move");
    }
    expect(moved.value.transport).toBe("rename");
    expect(moved.value.items[0]?.status).toBe("applied");
    const sourceGone = await fileSystem.stat(localPath("/work/project/src/a.ts"));
    expect(sourceGone.ok && sourceGone.value).toBeNull();
    const dest = await fileSystem.readText(localPath("/work/project/src/moved.ts"), 1_024);
    expect(dest).toEqual({ ok: true, value: "one\n" });

    const copied = await workspace.apply(root, {
      kind: "copy",
      source: "src/moved.ts",
      destination: "src/copy.ts",
    });
    expect(copied.ok).toBe(true);
    if (!copied.ok) {
      throw new Error("expected copy");
    }
    expect(copied.value.transport).toBeNull();
    const original = await fileSystem.readText(localPath("/work/project/src/moved.ts"), 1_024);
    const duplicate = await fileSystem.readText(localPath("/work/project/src/copy.ts"), 1_024);
    expect(original).toEqual({ ok: true, value: "one\n" });
    expect(duplicate).toEqual({ ok: true, value: "one\n" });
  });

  test("copies a symlink as a link and removes the link without following it", async () => {
    const { fileSystem, workspace } = mutator();
    const copied = await workspace.apply(root, {
      kind: "copy",
      source: "link",
      destination: "link2",
    });
    expect(copied.ok).toBe(true);
    const dest = await fileSystem.stat(localPath("/work/project/link2"));
    expect(dest.ok && dest.value?.kind).toBe("symlink");

    const removed = await workspace.apply(root, { kind: "remove", source: "link" });
    expect(removed.ok).toBe(true);
    const linkGone = await fileSystem.stat(localPath("/work/project/link"));
    expect(linkGone.ok && linkGone.value).toBeNull();
    const target = await fileSystem.readText(localPath("/etc/passwd"), 1_024);
    expect(target).toEqual({ ok: true, value: "root" });
  });

  test("refuses a non-empty directory without recursive and removes the tree when asked", async () => {
    const { fileSystem, workspace } = mutator();
    expect(await workspace.apply(root, { kind: "remove", source: "src" })).toEqual({
      ok: false,
      error: { code: "not-empty" },
    });
    const removed = await workspace.apply(root, {
      kind: "remove",
      source: "src",
      recursive: true,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) {
      throw new Error("expected recursive remove");
    }
    expect(removed.value.items.every((item) => item.status === "applied")).toBe(true);
    const gone = await fileSystem.stat(localPath("/work/project/src"));
    expect(gone.ok && gone.value).toBeNull();
  });

  test("trashes a file into an in-workspace directory", async () => {
    const { fileSystem, workspace } = mutator();
    const trashed = await workspace.apply(root, {
      kind: "trash",
      source: "src/a.ts",
      destination: ".trash",
    });
    expect(trashed.ok).toBe(true);
    if (!trashed.ok) {
      throw new Error("expected trash");
    }
    expect(trashed.value.transport).toBe("rename");
    const sourceGone = await fileSystem.stat(localPath("/work/project/src/a.ts"));
    expect(sourceGone.ok && sourceGone.value).toBeNull();
    const parked = await fileSystem.readText(localPath("/work/project/.trash/a.ts"), 1_024);
    expect(parked).toEqual({ ok: true, value: "one\n" });
  });

  test("refuses into-self, overwrite error, and a truncated recursive walk", async () => {
    const { workspace } = mutator();
    expect(
      await workspace.apply(root, {
        kind: "move",
        source: "src",
        destination: "src/nested/elsewhere",
        recursive: true,
      }),
    ).toEqual({ ok: false, error: { code: "into-self" } });
    expect(
      await workspace.apply(root, {
        kind: "copy",
        source: "src/a.ts",
        destination: "src/nested/b.ts",
      }),
    ).toEqual({ ok: false, error: { code: "already-exists" } });
    expect(
      await workspace.apply(root, {
        kind: "copy",
        source: "src",
        destination: "lib",
        recursive: true,
        maxEntries: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "too-broad" } });
  });

  test("replaces a dest file and merges directory children", async () => {
    const { fileSystem, workspace } = mutator({
      "/work/project/lib": { kind: "directory" },
      "/work/project/lib/keep.ts": { kind: "file", text: "keep\n" },
    });
    const replaced = await workspace.apply(root, {
      kind: "copy",
      source: "src/a.ts",
      destination: "lib/keep.ts",
      overwrite: "replace",
    });
    expect(replaced.ok).toBe(true);
    const after = await fileSystem.readText(localPath("/work/project/lib/keep.ts"), 1_024);
    expect(after).toEqual({ ok: true, value: "one\n" });

    const merged = await workspace.apply(root, {
      kind: "copy",
      source: "src/nested",
      destination: "lib",
      overwrite: "merge",
      recursive: true,
    });
    expect(merged.ok).toBe(true);
    const child = await fileSystem.readText(localPath("/work/project/lib/b.ts"), 1_024);
    expect(child).toEqual({ ok: true, value: "two\n" });
    const stillThere = await fileSystem.stat(localPath("/work/project/src/nested/b.ts"));
    expect(stillThere.ok && stillThere.value?.kind).toBe("file");
  });

  test("revalidates the preview plan identity", async () => {
    const { workspace } = mutator();
    const preview = await workspace.preview(root, {
      kind: "move",
      source: "src/a.ts",
      destination: "src/z.ts",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      throw new Error("expected preview");
    }
    expect(preview.value.planId.startsWith("mutate-")).toBe(true);
    expect(
      await workspace.apply(root, {
        kind: "move",
        source: "src/a.ts",
        destination: "src/z.ts",
        expectedPlanId: "mutate-00000000-1",
      }),
    ).toEqual({ ok: false, error: { code: "stale-plan" } });
    const applied = await workspace.apply(root, {
      kind: "move",
      source: "src/a.ts",
      destination: "src/z.ts",
      expectedPlanId: preview.value.planId,
    });
    expect(applied.ok).toBe(true);
  });

  test("copies then removes when rename reports cross-device", async () => {
    const { fileSystem } = mutator();
    const crossing: FileSystemPort = {
      ...fileSystem,
      renameEntry: async (from, _to, signal) => {
        if (signal?.aborted === true) {
          return fileSystem.renameEntry(from, _to, signal);
        }
        return {
          ok: false,
          error: {
            kind: "filesystem",
            code: "cross-device",
            path: from,
            operation: "rename",
          },
        };
      },
    };
    const result = await createWorkspaceMutator({ fileSystem: crossing }).apply(root, {
      kind: "move",
      source: "src/a.ts",
      destination: "src/other.ts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected cross-device move");
    }
    expect(result.value.transport).toBe("copy-verify-remove");
    const sourceGone = await fileSystem.stat(localPath("/work/project/src/a.ts"));
    expect(sourceGone.ok && sourceGone.value).toBeNull();
    const dest = await fileSystem.readText(localPath("/work/project/src/other.ts"), 1_024);
    expect(dest).toEqual({ ok: true, value: "one\n" });
  });

  test("keeps already-copied entries when later work is cancelled", async () => {
    const { fileSystem } = mutator();
    const controller = new AbortController();
    const aborting: FileSystemPort = {
      ...fileSystem,
      copyEntry: async (from, to, signal) => {
        if (String(from).endsWith("/src/a.ts")) {
          controller.abort();
          return {
            ok: false as const,
            error: {
              kind: "filesystem" as const,
              code: "cancelled" as const,
              path: from,
              operation: "copy" as const,
            },
          };
        }
        return fileSystem.copyEntry(from, to, signal);
      },
    };
    const result = await createWorkspaceMutator({ fileSystem: aborting }).apply(
      root,
      {
        kind: "copy",
        source: "src",
        destination: "lib",
        recursive: true,
      },
      controller.signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected partial copy");
    }
    expect(result.value.items.some((item) => item.status === "applied")).toBe(true);
    expect(result.value.items.some((item) => item.status === "cancelled")).toBe(true);
    const source = await fileSystem.stat(localPath("/work/project/src/a.ts"));
    expect(source.ok && source.value?.kind).toBe("file");
  });

  test("refuses an escaping destination and never echoes secrets", async () => {
    const { workspace } = mutator();
    const escaped = await workspace.apply(root, {
      kind: "copy",
      source: "src/a.ts",
      destination: "link/inside.ts",
    });
    expect(escaped).toEqual({ ok: false, error: { code: "symlink-escape" } });
    expect(JSON.stringify(escaped)).not.toContain("root");
    const secret = await workspace.apply(root, {
      kind: "copy",
      source: "src/a.ts",
      destination: "sk-live-SECRET\0",
    });
    expect(secret).toEqual({ ok: false, error: { code: "malformed-destination" } });
    expect(JSON.stringify(secret)).not.toContain("sk-live-SECRET");
  });
});
