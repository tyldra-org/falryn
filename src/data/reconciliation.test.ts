import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
  type RootLayout,
} from "../domain/index.ts";
import { reconcileTemporaryIngest } from "./reconciliation.ts";
import { resolveRoots } from "./roots.ts";

function layoutFor(): RootLayout {
  return resolveRoots({
    platform: "darwin",
    home: localPath("/Users/example"),
    environment: createStaticEnvironment({ FALRYN_TEMP_DIR: "/d/tmp" }),
  }).layout;
}

function reconcile(nodes: Readonly<Record<string, InMemoryNode>>, signal?: AbortSignal) {
  return reconcileTemporaryIngest(createInMemoryFileSystem({ nodes }), layoutFor(), signal);
}

describe("startup reconciliation of temporary ingest", () => {
  test("an absent root holds nothing, and that is a complete answer", async () => {
    const report = await reconcile({});
    expect(report).toEqual({
      root: localPath("/d/tmp"),
      entries: [],
      completeness: "complete",
      effect: "none",
    });
  });

  test("an empty root reports no effect", async () => {
    const report = await reconcile({ "/d/tmp": { kind: "directory" } });
    expect(report.entries).toEqual([]);
    expect(report.effect).toBe("none");
  });

  test("interrupted content is recorded as uncertain, never as completion", async () => {
    const report = await reconcile({
      "/d/tmp": { kind: "directory" },
      "/d/tmp/ingest-1.part": { kind: "file", byteLength: 512 },
      "/d/tmp/nested": { kind: "directory" },
      "/d/tmp/nested/ingest-2.part": { kind: "file", byteLength: 64 },
    });

    expect(report.effect).toBe("uncertain");
    expect(report.entries.map((entry) => String(entry.path)).sort()).toEqual([
      "/d/tmp/ingest-1.part",
      "/d/tmp/nested",
      "/d/tmp/nested/ingest-2.part",
    ]);
    expect(report.completeness).toBe("complete");
  });

  test("names the owner an entry's name claims, and guesses at no other", async () => {
    const report = await reconcile({
      "/d/tmp": { kind: "directory" },
      "/d/tmp/artifact-capture-1.part": { kind: "file", byteLength: 512 },
      "/d/tmp/something-else.tmp": { kind: "file", byteLength: 8 },
    });

    expect(report.entries.map((entry) => [String(entry.path), entry.owner]).sort()).toEqual([
      ["/d/tmp/artifact-capture-1.part", "artifact-ingest"],
      ["/d/tmp/something-else.tmp", "unknown"],
    ]);
  });

  test("naming an owner is not a claim that the write finished", async () => {
    const report = await reconcile({
      "/d/tmp": { kind: "directory" },
      "/d/tmp/artifact-capture-1.part": { kind: "file", byteLength: 512 },
    });

    // A half-written blob and a complete one are named identically, which is
    // exactly why the effect stays uncertain and nothing is removed.
    expect(report.effect).toBe("uncertain");
  });

  test("nothing is removed", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/d/tmp": { kind: "directory" },
        "/d/tmp/ingest-1.part": { kind: "file", byteLength: 512 },
      },
    });
    const before = fileSystem.paths();

    await reconcileTemporaryIngest(fileSystem, layoutFor());

    // Whether a leftover file represents finished work is knowable only by the
    // owner that wrote it, and no such owner exists yet. Deleting on the theory
    // that it must be abandoned would destroy resumable work.
    expect(fileSystem.paths()).toEqual(before);
  });

  test("a root that is a file is reported as a partial look", async () => {
    const report = await reconcile({ "/d/tmp": { kind: "file", byteLength: 4 } });
    expect(report.completeness).toBe("partial");
    expect(report.entries).toEqual([]);
  });

  test("cancellation reports what it saw as partial", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await reconcile(
      {
        "/d/tmp": { kind: "directory" },
        "/d/tmp/ingest-1.part": { kind: "file", byteLength: 512 },
      },
      controller.signal,
    );

    expect(report.completeness).toBe("partial");
  });
});
