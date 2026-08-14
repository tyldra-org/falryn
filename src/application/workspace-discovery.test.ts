import { describe, expect, test } from "bun:test";
import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createWorkspaceDiscovery } from "./workspace-discovery.ts";

const root = localPath("/work/project");

function discovery() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "sk-live-SECRET" },
      "/work/project/src/b.ts": { kind: "file", text: "b" },
      "/work/project/src/a.test.ts": { kind: "file", text: "test" },
      "/work/project/src/note.md": { kind: "file", text: "md" },
      "/work/project/.env": { kind: "file", text: "TOKEN=1" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/work/project/inside-link": { kind: "symlink", target: "/work/project/src" },
      "/work/project/secret": { kind: "directory" },
      "/work/project/secret/key.ts": { kind: "file", text: "hidden-key" },
      "/work/project/nested": { kind: "directory" },
      "/work/project/nested/mid": { kind: "directory" },
      "/work/project/nested/mid/leaf.ts": { kind: "file", text: "leaf" },
      "/etc/passwd": { kind: "file", text: "x" },
    },
  });
  return { fs, discovery: createWorkspaceDiscovery(fs) };
}

describe("createWorkspaceDiscovery", () => {
  test("discovers files matching a basename glob in path order", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, { include: ["*.ts"] });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    expect(found.value.matches.map((entry) => entry.logical)).toEqual([
      "nested/mid/leaf.ts",
      "secret/key.ts",
      "src/a.test.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(found.value.truncated).toBe(false);
  });

  test("excludes a directory tree and does not echo secrets", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, {
      include: ["*.ts"],
      exclude: ["secret/"],
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    const logicals = found.value.matches.map((entry) => entry.logical);
    expect(logicals).not.toContain("secret/key.ts");
    expect(logicals).toContain("src/a.ts");
    expect(JSON.stringify(found.value)).not.toContain("sk-live-SECRET");
    expect(JSON.stringify(found.value)).not.toContain("hidden-key");
  });

  test("omits hidden names unless asked", async () => {
    const { discovery: workspace } = discovery();
    const hiddenOff = await workspace.discover(root, { include: ["*"] });
    expect(hiddenOff.ok).toBe(true);
    if (!hiddenOff.ok) {
      throw new Error("expected discovery");
    }
    expect(hiddenOff.value.matches.map((entry) => entry.logical)).not.toContain(".env");

    const hiddenOn = await workspace.discover(root, { include: ["*"], includeHidden: true });
    expect(hiddenOn.ok).toBe(true);
    if (!hiddenOn.ok) {
      throw new Error("expected discovery");
    }
    expect(hiddenOn.value.matches.map((entry) => entry.logical)).toContain(".env");
  });

  test("does not descend through a symlink and refuses an escaping start", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, { include: ["**"] });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    const logicals = found.value.matches.map((entry) => entry.logical);
    expect(logicals).toContain("inside-link");
    expect(logicals.filter((path) => path.startsWith("inside-link/"))).toEqual([]);
    expect(await workspace.discover(root, { start: "out", include: ["**"] })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("truncates at the match budget before the walk budget", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, { include: ["*.ts"], maxMatches: 2 });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    expect(found.value.matches).toHaveLength(2);
    expect(found.value.truncated).toBe(true);
    expect(found.value.truncation).toBe("match-limit");
  });

  test("reports a walk entry-limit when the scan is incomplete", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, {
      include: ["**"],
      maxWalkEntries: 2,
      maxMatches: 50,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    expect(found.value.truncated).toBe(true);
    expect(found.value.truncation).toBe("entry-limit");
  });

  test("cancels before walking when the signal is already aborted", async () => {
    const { discovery: workspace } = discovery();
    const controller = new AbortController();
    controller.abort();
    expect(await workspace.discover(root, { include: ["*.ts"] }, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("returns an empty success when nothing matches", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, { include: ["*.wasm"] });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    expect(found.value.matches).toEqual([]);
    expect(found.value.truncated).toBe(false);
  });

  test("filters to files when kinds is file", async () => {
    const { discovery: workspace } = discovery();
    const found = await workspace.discover(root, { include: ["src/**"], kinds: "file" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected discovery");
    }
    expect(found.value.matches.every((entry) => entry.kind === "file")).toBe(true);
    expect(found.value.matches.map((entry) => entry.logical)).toContain("src/a.ts");
    expect(found.value.matches.map((entry) => entry.logical)).not.toContain("src");
  });
});
