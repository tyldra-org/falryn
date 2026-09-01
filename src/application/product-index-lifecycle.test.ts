/**
 * Product index lifecycle (#716).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ok,
  parseLocalPath,
  type WorkspaceIndexGeneration,
  type WorkspaceIndexWritePort,
} from "../domain/index.ts";
import { createHostFileSystem } from "../integrations/index.ts";
import {
  composeProductIndexLifecycle,
  createEphemeralProductIndexPort,
  PRODUCT_INDEX_LIFECYCLE_OWNER,
} from "./product-index-lifecycle.ts";

function writePort(): WorkspaceIndexWritePort & {
  readonly last: { current: WorkspaceIndexGeneration | null };
} {
  const last = { current: null as WorkspaceIndexGeneration | null };
  return {
    last,
    async rebuild(generation, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      last.current = generation;
      return ok(generation);
    },
  };
}

describe("composeProductIndexLifecycle", () => {
  test("exposes rebuilt ephemeral generations through the read port", async () => {
    const index = createEphemeralProductIndexPort();
    const root = parseLocalPath("/work/project");
    if (!root.ok) {
      throw new Error(root.error.code);
    }
    expect((await index.snapshot(root.value)).ok).toBe(false);
    const generation: WorkspaceIndexGeneration = {
      id: "generation-1",
      schema: "workspace-index/v1",
      lifecycle: "ready",
      records: [],
    };
    expect((await index.rebuild(generation)).ok).toBe(true);
    expect(await index.snapshot(root.value)).toEqual(ok(generation));
  });

  test("rebuilds from workspace inventory and tags ready freshness", async () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "falryn-index-lifecycle-")));
    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "main.ts"), "export function main() {}\n", "utf8");
    writeFileSync(join(rootDir, "README.md"), "# Demo\n", "utf8");

    const root = parseLocalPath(rootDir);
    expect(root.ok).toBe(true);
    if (!root.ok) {
      return;
    }
    const index = writePort();
    const lifecycle = composeProductIndexLifecycle({
      fileSystem: createHostFileSystem(),
      workspaceRoot: root.value,
      index,
    });
    expect(lifecycle.status().freshness).toBe("absent");
    expect(lifecycle.owner).toBe(PRODUCT_INDEX_LIFECYCLE_OWNER);

    const rebuilt = await lifecycle.rebuild();
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(rebuilt.value.fileCount).toBeGreaterThan(0);
    expect(lifecycle.status().freshness).toBe("ready");
    expect(lifecycle.status().generationId).toBe(rebuilt.value.generation.id);
    expect(index.last.current?.id).toBe(rebuilt.value.generation.id);

    const refreshed = await lifecycle.refresh();
    expect(refreshed.ok).toBe(true);
  });

  test("fails closed when inventory has no admitted sources", async () => {
    const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "falryn-index-empty-")));
    const root = parseLocalPath(rootDir);
    expect(root.ok).toBe(true);
    if (!root.ok) {
      return;
    }
    const lifecycle = composeProductIndexLifecycle({
      fileSystem: createHostFileSystem(),
      workspaceRoot: root.value,
      index: writePort(),
    });
    const rebuilt = await lifecycle.rebuild();
    expect(rebuilt.ok).toBe(false);
    expect(lifecycle.status().freshness).toBe("failed");
  });
});
