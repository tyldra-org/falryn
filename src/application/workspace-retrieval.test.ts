import { describe, expect, test } from "bun:test";
import {
  createInMemoryEmbeddingCorpus,
  createInMemoryEmbeddingPort,
  createInMemoryFileSystem,
  createInMemoryWorkspaceIndex,
  type EmbeddingPort,
  localPath,
  ok,
} from "../domain/index.ts";
import { createWorkspaceRetrieval } from "./workspace-retrieval.ts";

const root = localPath("/work/project");

function embedding(
  name: string,
  logical: string,
  vector: readonly number[],
  destination: "local" | "remote" = "local",
) {
  return {
    logical,
    kind: "symbol" as const,
    name,
    startLine: 1,
    endLine: 1,
    digest: "d1",
    chunkerVersion: "chunker/v1",
    provider: "test",
    model: "toy",
    dimensions: vector.length,
    normalization: "l2" as const,
    destination,
    vector,
  };
}

function harness(options?: {
  readonly lifecycle?: "absent" | "building" | "ready" | "stale" | "corrupt" | "unavailable";
  readonly revision?: string;
  readonly embeddings?: EmbeddingPort;
  readonly corpusId?: string;
  readonly remoteOnly?: boolean;
  readonly omitEmbeddings?: boolean;
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
      "/work/project/.env": { kind: "file", text: "TOKEN=sk-live-SECRET", revision: "rev-env" },
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
        logical: ".env",
        kind: "chunk",
        name: "TOKEN",
        text: "TOKEN=sk-live-SECRET",
        startLine: 1,
        endLine: 1,
        revision: "rev-env",
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
  const destination = options?.remoteOnly === true ? "remote" : "local";
  const corpus = createInMemoryEmbeddingCorpus({
    id: options?.corpusId ?? "gen-1",
    records: [
      embedding("foo", "src/a.ts", [1, 0], destination),
      embedding("b", "src/b.ts", [0.2, 0.8], destination),
    ],
  });
  const embeddings =
    options?.embeddings ??
    createInMemoryEmbeddingPort(
      ok({
        vector: [1, 0],
        provider: "test",
        model: "toy",
        dimensions: 2,
        destination: "local",
      }),
    );
  const retrievalOptions =
    options?.omitEmbeddings === true
      ? { fileSystem, index }
      : { fileSystem, index, embeddings, corpus };
  return {
    fileSystem,
    embeddings,
    retrieve: createWorkspaceRetrieval(retrievalOptions),
  };
}

describe("createWorkspaceRetrieval", () => {
  test("fuses scores and builds a primary context pack item", async () => {
    const { retrieve } = harness();
    const found = await retrieve.retrieve(root, { query: "foo" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected retrieval");
    }
    expect(found.value.semantic).toBe("used");
    expect(found.value.destination).toBe("local");
    expect(found.value.hits[0]?.logical).toBe("src/a.ts");
    expect(found.value.hits[0]?.freshness).toBe("current");
    expect(found.value.hits[0]?.scores.structural).toBe(1);
    expect(found.value.hits[0]?.scores.semantic).toBeCloseTo(1);
    expect(found.value.pack.items[0]?.role).toBe("primary");
    expect(found.value.pack.items[0]?.expansion).toEqual({
      kind: "read-range",
      logical: "src/a.ts",
      startLine: 1,
      endLine: 1,
    });
  });

  test("falls back without calling embeddings when the port is omitted", async () => {
    const { retrieve } = harness({ omitEmbeddings: true });
    const found = await retrieve.retrieve(root, { query: "token" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected retrieval");
    }
    expect(found.value.semantic).toBe("unavailable");
    expect(found.value.destination).toBeNull();
    expect(found.value.hits.map((hit) => hit.logical)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(found.value.hits.every((hit) => hit.scores.semantic === 0)).toBe(true);
  });

  test("does not send private corpus to a remote destination without opt-in", async () => {
    let embedCalls = 0;
    const embeddings = {
      async embedQuery() {
        embedCalls += 1;
        return ok({
          vector: [1, 0],
          provider: "test",
          model: "toy",
          dimensions: 2,
          destination: "remote" as const,
        });
      },
    };
    const { retrieve } = harness({ embeddings, remoteOnly: true });
    const found = await retrieve.retrieve(root, { query: "foo" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected retrieval");
    }
    expect(embedCalls).toBe(0);
    expect(found.value.semantic).toBe("denied");
    expect(JSON.stringify(found)).not.toContain("sk-live-SECRET");
  });

  test("labels stale hits without presenting them as current evidence", async () => {
    const { retrieve } = harness({ revision: "old" });
    const found = await retrieve.retrieve(root, { query: "foo" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected retrieval");
    }
    expect(found.value.hits[0]?.freshness).toBe("stale");
    expect(found.value.pack.items[0]?.fidelity).toBe("extractive");
  });

  test("skips escaping index paths and hidden files unless requested", async () => {
    const { retrieve } = harness({ omitEmbeddings: true });
    const found = await retrieve.retrieve(root, { query: "token" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected retrieval");
    }
    expect(found.value.hits.map((hit) => hit.logical)).not.toContain("../outside.ts");
    expect(found.value.hits.map((hit) => hit.logical)).not.toContain(".env");
  });

  test("cancels before scoring", async () => {
    const { retrieve } = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await retrieve.retrieve(root, { query: "foo" }, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("returns typed errors for unusable index generations", async () => {
    expect(
      (await harness({ lifecycle: "absent" }).retrieve.retrieve(root, { query: "foo" })).ok,
    ).toBe(false);
    expect(
      (await harness({ lifecycle: "building" }).retrieve.retrieve(root, { query: "foo" })).ok,
    ).toBe(false);
    const mismatch = await harness({ corpusId: "gen-other" }).retrieve.retrieve(root, {
      query: "foo",
    });
    expect(mismatch.ok).toBe(true);
    if (!mismatch.ok) {
      throw new Error("expected fallback");
    }
    expect(mismatch.value.semantic).toBe("corpus-mismatch");
  });
});
