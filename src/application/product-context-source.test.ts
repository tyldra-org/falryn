import { describe, expect, test } from "bun:test";

import { createInMemoryFileSystem, localPath, ok, workspaceId } from "../domain/index.ts";
import { composeProductIndexLifecycle, createEphemeralProductIndexPort } from "./index.ts";
import { createProductContextSource } from "./product-context-source.ts";

async function indexedSource() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/workspace": { kind: "directory" },
      "/workspace/src": { kind: "directory" },
      "/workspace/src/compose.ts": {
        kind: "file",
        text: "export function composeTurn() { return 'ready'; }\n",
      },
    },
  });
  const index = createEphemeralProductIndexPort();
  const lifecycle = composeProductIndexLifecycle({
    fileSystem,
    workspaceRoot: localPath("/workspace"),
    index,
  });
  expect((await lifecycle.rebuild()).ok).toBe(true);
  return {
    fileSystem,
    source: createProductContextSource({
      fileSystem,
      index,
      workspaceRoot: localPath("/workspace"),
      workspaceId: workspaceId.from("workspace-context"),
    }),
  };
}

describe("createProductContextSource", () => {
  test("turns current bounded index hits into attributed prompt evidence", async () => {
    const { source } = await indexedSource();
    const prepared = await source.prepare("Where is `composeTurn` defined?");

    expect(prepared.receipt.status).toBe("ready");
    expect(prepared.receipt.generation).not.toBeNull();
    expect(prepared.candidates.length).toBeGreaterThan(0);
    const candidate = prepared.candidates[0];
    expect(candidate?.origin).toContain("src/compose.ts");
    expect(candidate?.fidelity).toBe("bounded-excerpt");
    expect(candidate?.exactSource).toBeNull();
  });

  test("omits stale index hits instead of presenting them as current", async () => {
    const { fileSystem, source } = await indexedSource();
    fileSystem.put("/workspace/src/compose.ts", {
      kind: "file",
      text: "export function composeTurn() { return 'changed'; }\n",
    });

    const prepared = await source.prepare("`composeTurn`");
    expect(prepared.receipt.status).toBe("empty");
    expect(prepared.receipt.staleOmitted).toBeGreaterThan(0);
    expect(prepared.candidates).toEqual([]);
  });

  test("distinguishes an unavailable index from an empty result", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/workspace": { kind: "directory" } },
    });
    const source = createProductContextSource({
      fileSystem,
      index: {
        async snapshot() {
          return { ok: false as const, error: { code: "index-absent" as const } };
        },
      },
      workspaceRoot: localPath("/workspace"),
      workspaceId: workspaceId.from("workspace-context"),
    });

    const prepared = await source.prepare("find composeTurn");
    expect(prepared.receipt.status).toBe("unavailable");
    expect(prepared.receipt.code).toBe("index-absent");
    expect(prepared.sections[0]?.available).toBe(false);
  });

  test("reports cancellation before querying", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = createProductContextSource({
      fileSystem: createInMemoryFileSystem(),
      index: {
        async snapshot() {
          return ok({ id: "unused", schema: "unused", lifecycle: "ready", records: [] });
        },
      },
      workspaceRoot: localPath("/workspace"),
      workspaceId: workspaceId.from("workspace-context"),
    });

    expect((await source.prepare("find composeTurn", controller.signal)).receipt.status).toBe(
      "cancelled",
    );
  });
});
