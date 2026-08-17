import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceIndexQuery } from "../application/workspace-index.ts";
import { createWorkspaceIndexBuilder } from "../application/workspace-index-build.ts";
import { createSystemClock, localPath } from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import { openWorkspaceIndexStore } from "./workspace-index-store.ts";

describe("workspace index sqlite store", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("rebuilds a generation and serves query hits", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-index-"));
    roots.push(root);
    const databasePath = localPath(join(root, "index.sqlite"));
    const backupDirectory = localPath(join(root, "backups"));
    const opened = await openWorkspaceIndexStore({
      open: openBunSqlite,
      clock: createSystemClock(),
      databasePath,
      backupDirectory,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      return;
    }
    const store = opened.value;
    const builder = createWorkspaceIndexBuilder({ index: store });
    const rebuilt = await builder.rebuildFromSources(
      [
        {
          logical: "src/a.ts",
          revision: "rev-a",
          text: "export function token() { return 1; }\n",
        },
      ],
      { generationId: "gen-1" },
    );
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) {
      return;
    }
    expect(rebuilt.value.generation.records.some((record) => record.name === "token")).toBe(true);

    const snapshot = await store.snapshot(localPath(root));
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      return;
    }
    expect(snapshot.value.id).toBe("gen-1");
    expect(snapshot.value.lifecycle).toBe("ready");

    // Freshness verification needs a real filesystem file; use in-memory FS via query without FS verify path —
    // createWorkspaceIndexQuery requires FileSystemPort. Use a minimal stub that reports matching revision.
    const { createInMemoryFileSystem } = await import("../domain/index.ts");
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        [root]: { kind: "directory" },
        [`${root}/src`]: { kind: "directory" },
        [`${root}/src/a.ts`]: {
          kind: "file",
          text: "export function token() { return 1; }\n",
          revision: "rev-a",
        },
      },
    });
    const query = createWorkspaceIndexQuery({ fileSystem, index: store });
    const result = await query.query(localPath(root), { query: "token", kind: "structural" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hits.length).toBeGreaterThan(0);
      expect(result.value.generation).toBe("gen-1");
    }

    await store.close();
  });
});
