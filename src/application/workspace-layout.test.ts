import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  createWorkspaceSet,
  localPath,
  workspaceRootId,
} from "../domain/index.ts";
import { createWorkspaceLayoutStore } from "./workspace-layout.ts";

const rootA = workspaceRootId.from("root-a");
const rootB = workspaceRootId.from("root-b");
const configRoot = localPath("/home/user/.config/falryn");

function sampleSet() {
  const set = createWorkspaceSet([
    { rootId: rootA, name: "falryn", path: localPath("/work/falryn") },
    { rootId: rootB, name: "docs", path: localPath("/work/docs") },
  ]);
  expect(set.ok).toBe(true);
  if (!set.ok) {
    throw new Error("expected set");
  }
  return set.value;
}

function storeWithRoots() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/home/user/.config/falryn": { kind: "directory" },
      "/work/falryn": { kind: "directory" },
      "/work/docs": { kind: "directory" },
    },
  });
  return { fs, store: createWorkspaceLayoutStore(fs, configRoot) };
}

describe("createWorkspaceLayoutStore", () => {
  test("saves and loads a workspace set round-trip", async () => {
    const { store } = storeWithRoots();
    const saved = await store.save("falryn-app", sampleSet());
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      throw new Error("expected save");
    }
    const loaded = await store.load("falryn-app");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      throw new Error("expected load");
    }
    expect(loaded.value.set.roots.map((root) => root.name)).toEqual(["falryn", "docs"]);
    expect(loaded.value.layout.name as string).toBe("falryn-app");
  });

  test("refuses overwrite without force", async () => {
    const { store } = storeWithRoots();
    expect((await store.save("falryn-app", sampleSet())).ok).toBe(true);
    expect(await store.save("falryn-app", sampleSet())).toEqual({
      ok: false,
      error: { code: "exists" },
    });
    const forced = await store.save("falryn-app", sampleSet(), { force: true });
    expect(forced.ok).toBe(true);
  });

  test("names every unusable root on load", async () => {
    const { fs, store } = storeWithRoots();
    expect((await store.save("broken", sampleSet())).ok).toBe(true);
    fs.put("/work/docs", { kind: "file", text: "not-a-dir" });
    const loaded = await store.load("broken");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      throw new Error("expected failure");
    }
    expect(loaded.error).toEqual({
      code: "unusable-roots",
      unusable: [{ path: "/work/docs", reason: "not-directory" }],
    });
  });

  test("reports every missing root without dropping others silently", async () => {
    const { fs, store } = storeWithRoots();
    expect((await store.save("gone", sampleSet())).ok).toBe(true);
    const text = await fs.readText(
      localPath("/home/user/.config/falryn/layouts/gone.jsonc"),
      64 * 1024,
    );
    expect(text.ok).toBe(true);
    if (!text.ok) {
      throw new Error("expected layout file");
    }
    const isolated = createInMemoryFileSystem({
      nodes: {
        "/home/user/.config/falryn": { kind: "directory" },
        "/home/user/.config/falryn/layouts": { kind: "directory" },
        "/home/user/.config/falryn/layouts/gone.jsonc": { kind: "file", text: text.value },
      },
    });
    const loaded = await createWorkspaceLayoutStore(isolated, configRoot).load("gone");
    expect(loaded.ok).toBe(false);
    if (loaded.ok || loaded.error.code !== "unusable-roots") {
      throw new Error("expected unusable-roots");
    }
    expect(loaded.error.unusable.map((item) => item.path).sort()).toEqual([
      "/work/docs",
      "/work/falryn",
    ]);
  });

  test("lists layouts with a bounded expansion route", async () => {
    const { store } = storeWithRoots();
    for (const name of ["alpha", "beta", "gamma"]) {
      expect((await store.save(name, sampleSet())).ok).toBe(true);
    }
    const listed = await store.list({ limit: 2 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected list");
    }
    expect(listed.value.layouts.map((entry) => entry.name as string)).toEqual(["alpha", "beta"]);
    expect(listed.value.omitted).toBe(1);
    expect(listed.value.expansion).toBe("workspace list --limit 256");
  });

  test("returns an empty catalog when the layouts directory is absent", async () => {
    const fs = createInMemoryFileSystem({
      nodes: {
        "/home/user/.config/falryn": { kind: "directory" },
      },
    });
    const store = createWorkspaceLayoutStore(fs, configRoot);
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected list");
    }
    expect(listed.value.layouts).toEqual([]);
    expect(listed.value.omitted).toBe(0);
    expect(listed.value.expansion).toBeNull();
  });
});
