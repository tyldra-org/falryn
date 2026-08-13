import { describe, expect, test } from "bun:test";
import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";

const root = localPath("/work/project");

function listing() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "sk-live-SECRET" },
      "/work/project/src/b.ts": { kind: "file", text: "b" },
      "/work/project/.env": { kind: "file", text: "TOKEN=1" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/work/project/inside-link": { kind: "symlink", target: "/work/project/src" },
      "/work/project/nested": { kind: "directory" },
      "/work/project/nested/mid": { kind: "directory" },
      "/work/project/nested/mid/leaf.ts": { kind: "file", text: "leaf" },
      "/etc/passwd": { kind: "file", text: "x" },
    },
  });
  return { fs, listing: createWorkspaceListing(fs) };
}

describe("createWorkspaceListing", () => {
  test("stats a file without following anything", async () => {
    const { listing: workspace } = listing();
    const stated = await workspace.stat(root, "src/a.ts");
    expect(stated.ok).toBe(true);
    if (!stated.ok) {
      throw new Error("expected stat");
    }
    expect(stated.value.kind).toBe("file");
    expect(stated.value.logical).toBe("src/a.ts");
    expect(stated.value.byteLength).toBeGreaterThan(0);
  });

  test("refuses a missing path", async () => {
    const { listing: workspace } = listing();
    expect(await workspace.stat(root, "missing.ts")).toEqual({
      ok: false,
      error: { code: "not-found" },
    });
  });

  test("lists one directory in path order", async () => {
    const { listing: workspace } = listing();
    const listed = await workspace.list(root, "src");
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected list");
    }
    expect(listed.value.entries.map((entry) => entry.logical)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(listed.value.truncated).toBe(false);
  });

  test("refuses to list a file", async () => {
    const { listing: workspace } = listing();
    expect(await workspace.list(root, "src/a.ts")).toEqual({
      ok: false,
      error: { code: "not-a-directory" },
    });
  });

  test("does not follow a symlink when listing", async () => {
    const { listing: workspace } = listing();
    expect(await workspace.list(root, "inside-link")).toEqual({
      ok: false,
      error: { code: "not-a-directory" },
    });
  });

  test("walks directories but never descends through a symlink", async () => {
    const { listing: workspace } = listing();
    const walked = await workspace.walk(root, ".");
    expect(walked.ok).toBe(true);
    if (!walked.ok) {
      throw new Error("expected walk");
    }
    const logicals = walked.value.entries.map((entry) => entry.logical);
    expect(logicals).toContain("src/a.ts");
    expect(logicals).toContain("inside-link");
    expect(logicals.filter((path) => path.startsWith("inside-link/"))).toEqual([]);
    expect(walked.value.entries.find((entry) => entry.logical === "inside-link")?.kind).toBe(
      "symlink",
    );
  });

  test("refuses a symlink whose real path leaves the root", async () => {
    const { listing: workspace } = listing();
    expect(await workspace.stat(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("omits hidden names when asked", async () => {
    const { listing: workspace } = listing();
    const listed = await workspace.list(root, ".", { includeHidden: false });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected list");
    }
    expect(listed.value.entries.map((entry) => entry.logical)).not.toContain(".env");
  });

  test("truncates a walk at the entry budget", async () => {
    const { listing: workspace } = listing();
    const walked = await workspace.walk(root, ".", { maxEntries: 2 });
    expect(walked.ok).toBe(true);
    if (!walked.ok) {
      throw new Error("expected walk");
    }
    expect(walked.value.entries).toHaveLength(2);
    expect(walked.value.truncated).toBe(true);
    expect(walked.value.truncation).toBe("entry-limit");
  });

  test("stops descent at the depth budget", async () => {
    const { listing: workspace } = listing();
    const walked = await workspace.walk(root, "nested", { maxDepth: 1 });
    expect(walked.ok).toBe(true);
    if (!walked.ok) {
      throw new Error("expected walk");
    }
    const logicals = walked.value.entries.map((entry) => entry.logical);
    expect(logicals).toContain("nested");
    expect(logicals).toContain("nested/mid");
    expect(logicals).not.toContain("nested/mid/leaf.ts");
    expect(walked.value.truncation).toBe("depth-limit");
  });

  test("does not read file bytes", async () => {
    const { listing: workspace } = listing();
    const walked = await workspace.walk(root, "src");
    expect(walked.ok).toBe(true);
    if (!walked.ok) {
      throw new Error("expected walk");
    }
    expect(JSON.stringify(walked.value)).not.toContain("sk-live-SECRET");
  });

  test("honors cancellation", async () => {
    const { listing: workspace } = listing();
    const signal = AbortSignal.abort();
    expect(await workspace.list(root, "src", undefined, signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
