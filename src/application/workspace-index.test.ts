import { describe, expect, test } from "bun:test";
import {
  createInMemoryFileSystem,
  createInMemoryWorkspaceIndex,
  localPath,
} from "../domain/index.ts";
import { createWorkspaceIndexQuery } from "./workspace-index.ts";

const root = localPath("/work/project");

function harness(options?: {
  readonly lifecycle?: "absent" | "building" | "ready" | "stale" | "corrupt" | "unavailable";
  readonly revision?: string;
}) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": {
        kind: "file",
        text: "export function foo() {}",
        revision: "rev-a",
      },
      "/work/project/src/b.ts": { kind: "file", text: "token in b", revision: "rev-b" },
      "/work/project/src/note.md": { kind: "file", text: "# Token heading", revision: "rev-md" },
      "/work/project/.env": { kind: "file", text: "TOKEN=sk-live-SECRET", revision: "rev-env" },
      "/work/project/secret": { kind: "directory" },
      "/work/project/secret/key.ts": {
        kind: "file",
        text: "export function hidden() {}",
        revision: "rev-key",
      },
    },
  });
  const index = createInMemoryWorkspaceIndex({
    id: "gen-1",
    schema: "workspace-index/v1",
    lifecycle: options?.lifecycle ?? "ready",
    records: [
      {
        logical: "src/a.ts",
        kind: "symbol",
        name: "foo",
        text: "export function foo() { return token; }",
        startLine: 1,
        endLine: 1,
        revision: options?.revision ?? "rev-a",
      },
      {
        logical: "src/b.ts",
        kind: "chunk",
        name: "b",
        text: "token in b",
        startLine: 1,
        endLine: 1,
        revision: "rev-b",
      },
      {
        logical: "src/note.md",
        kind: "heading",
        name: "Token heading",
        text: "# Token heading",
        startLine: 1,
        endLine: 1,
        revision: "rev-md",
      },
      {
        logical: ".env",
        kind: "chunk",
        name: "TOKEN",
        text: "TOKEN=sk-live-SECRET",
        startLine: 1,
        endLine: 1,
        revision: "rev-env",
      },
      {
        logical: "secret/key.ts",
        kind: "symbol",
        name: "hidden",
        text: "export function hidden() { return token; }",
        startLine: 1,
        endLine: 1,
        revision: "rev-key",
      },
      {
        logical: "../outside.ts",
        kind: "symbol",
        name: "escape",
        text: "token",
        startLine: 1,
        endLine: 1,
        revision: "rev-out",
      },
    ],
  });
  return {
    fileSystem,
    query: createWorkspaceIndexQuery({ fileSystem, index }),
  };
}

describe("createWorkspaceIndexQuery", () => {
  test("returns current structural hits in path order", async () => {
    const { query } = harness();
    const found = await query.query(root, { query: "foo", kind: "structural" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    expect(found.value.generation).toBe("gen-1");
    expect(found.value.lifecycle).toBe("ready");
    expect(found.value.hits.map((hit) => hit.logical)).toEqual(["src/a.ts"]);
    expect(found.value.hits[0]?.freshness).toBe("current");
    expect(found.value.hits[0]?.kind).toBe("symbol");
  });

  test("matches lexical text and honors exclude globs", async () => {
    const { query } = harness();
    const found = await query.query(root, {
      query: "token",
      kind: "lexical",
      exclude: ["secret/"],
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    const logicals = found.value.hits.map((hit) => hit.logical);
    expect(logicals).toEqual(["src/a.ts", "src/b.ts"]);
    expect(logicals).not.toContain("secret/key.ts");
    expect(logicals).not.toContain(".env");
  });

  test("omits hidden names unless asked", async () => {
    const { query } = harness();
    const hidden = await query.query(root, {
      query: "TOKEN",
      kind: "lexical",
      includeHidden: true,
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) {
      throw new Error("expected query");
    }
    expect(hidden.value.hits.map((hit) => hit.logical)).toContain(".env");
  });

  test("marks a hit stale when the workspace revision moved", async () => {
    const { query } = harness({ revision: "rev-old" });
    const found = await query.query(root, { query: "foo", kind: "structural" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    expect(found.value.hits).toHaveLength(1);
    expect(found.value.hits[0]?.freshness).toBe("stale");
    expect(found.value.hits[0]?.logical).toBe("src/a.ts");
  });

  test("does not follow an escaping index path", async () => {
    const { query } = harness();
    const found = await query.query(root, { query: "escape", kind: "structural" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    expect(found.value.hits).toEqual([]);
  });

  test("refuses absent, building, and corrupt generations", async () => {
    expect(await harness({ lifecycle: "absent" }).query.query(root, { query: "foo" })).toEqual({
      ok: false,
      error: { code: "index-absent" },
    });
    expect(await harness({ lifecycle: "building" }).query.query(root, { query: "foo" })).toEqual({
      ok: false,
      error: { code: "index-not-ready", lifecycle: "building" },
    });
    expect(await harness({ lifecycle: "corrupt" }).query.query(root, { query: "foo" })).toEqual({
      ok: false,
      error: { code: "index-corrupt" },
    });
    expect(await harness({ lifecycle: "unavailable" }).query.query(root, { query: "foo" })).toEqual(
      {
        ok: false,
        error: { code: "unavailable" },
      },
    );
  });

  test("still queries a stale generation and reports per-hit freshness", async () => {
    const { query } = harness({ lifecycle: "stale" });
    const found = await query.query(root, { query: "foo" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    expect(found.value.lifecycle).toBe("stale");
    expect(found.value.hits[0]?.freshness).toBe("current");
  });

  test("truncates at the match budget", async () => {
    const { query } = harness();
    const found = await query.query(root, { query: "t", kind: "lexical", maxMatches: 1 });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected query");
    }
    expect(found.value.hits).toHaveLength(1);
    expect(found.value.truncated).toBe(true);
    expect(found.value.truncation).toBe("match-limit");
  });

  test("cancels before snapshot when the signal is already aborted", async () => {
    const { query } = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await query.query(root, { query: "foo" }, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("does not echo file secrets in a malformed request error", async () => {
    const { query } = harness();
    const found = await query.query(root, { query: "" });
    expect(found).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "empty" },
    });
    expect(JSON.stringify(found)).not.toContain("sk-live-SECRET");
  });
});
