import { describe, expect, test } from "bun:test";

import { createInMemoryFileSystem, workspaceRootId } from "../domain/index.ts";
import { createWorkspaceSetBinder, resolveWorkspaceSet } from "./workspace-set.ts";

const rootA = workspaceRootId.from("root-a");
const rootB = workspaceRootId.from("root-b");

describe("resolveWorkspaceSet", () => {
  test("resolves absolute roots through realPath", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
        "/work/falryn-docs": { kind: "directory" },
      },
    });
    const set = await resolveWorkspaceSet(fs, [
      { rootId: rootA, name: "falryn", path: "/work/falryn" },
      { rootId: rootB, name: "falryn-docs", path: "/work/falryn-docs" },
    ]);
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error("expected set");
    }
    expect(set.value.roots.map((root) => root.name)).toEqual(["falryn", "falryn-docs"]);
  });

  test("refuses a missing root", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
      },
    });
    expect(
      await resolveWorkspaceSet(fs, [
        { rootId: rootA, name: "falryn", path: "/work/falryn" },
        { rootId: rootB, name: "docs", path: "/work/missing" },
      ]),
    ).toEqual({ ok: false, error: { code: "missing" } });
  });

  test("refuses a file root", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
        "/work/file.txt": { kind: "file", text: "x" },
      },
    });
    expect(
      await resolveWorkspaceSet(fs, [
        { rootId: rootA, name: "falryn", path: "/work/falryn" },
        { rootId: rootB, name: "file", path: "/work/file.txt" },
      ]),
    ).toEqual({ ok: false, error: { code: "not-directory" } });
  });

  test("refuses overlapping resolved roots", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work": { kind: "directory" },
        "/work/falryn": { kind: "directory" },
      },
    });
    expect(
      await resolveWorkspaceSet(fs, [
        { rootId: rootA, name: "parent", path: "/work" },
        { rootId: rootB, name: "child", path: "/work/falryn" },
      ]),
    ).toEqual({ ok: false, error: { code: "overlapping-roots" } });
  });
});

describe("createWorkspaceSetBinder", () => {
  test("reports rootId and refuses symlink escape from the chosen root", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
        "/work/falryn-docs": { kind: "directory" },
        "/work/falryn-docs/out": { kind: "symlink", target: "/etc/passwd" },
        "/etc/passwd": { kind: "file", text: "x" },
      },
    });
    const set = await resolveWorkspaceSet(fs, [
      { rootId: rootA, name: "falryn", path: "/work/falryn" },
      { rootId: rootB, name: "falryn-docs", path: "/work/falryn-docs" },
    ]);
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error("expected set");
    }
    const binder = createWorkspaceSetBinder(fs);
    const inside = await binder.bind(set.value, "README.md", { rootId: rootB });
    expect(inside.ok).toBe(true);
    if (!inside.ok) {
      throw new Error("expected bind");
    }
    expect(inside.value.rootId).toBe(rootB);

    expect(await binder.bind(set.value, "out", { rootId: rootB })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("honors cancellation before probing", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/work/falryn": { kind: "directory" },
      },
    });
    const set = await resolveWorkspaceSet(fs, [
      { rootId: rootA, name: "falryn", path: "/work/falryn" },
    ]);
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error("expected set");
    }
    const binder = createWorkspaceSetBinder(fs);
    expect(await binder.bind(set.value, "a.ts", { signal: AbortSignal.abort() })).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
