import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createInMemoryFileSystem, type InMemoryNode, localPath } from "../domain/index.ts";
import { createWorkspacePatcher } from "./workspace-patch.ts";

const root = localPath("/work/project");

function patcher(nodes: Record<string, InMemoryNode> = {}) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "one\ntwo\nthree\n", revision: "rev-a" },
      "/work/project/src/b.ts": { kind: "file", text: "alpha\n", revision: "rev-b" },
      "/work/project/src/dir": { kind: "directory" },
      "/work/project/link": { kind: "symlink", target: "/etc/passwd" },
      "/etc/passwd": { kind: "file", text: "root" },
      ...nodes,
    },
  });
  return { fileSystem, workspace: createWorkspacePatcher({ fileSystem }) };
}

function digestFor(text: string): string {
  return `sha-256:${createHash("sha256").update(text).digest("hex")}`;
}

describe("createWorkspacePatcher", () => {
  test("previews and applies an exact hunk", async () => {
    const { fileSystem, workspace } = patcher();
    const preview = await workspace.preview(root, {
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }],
        },
      ],
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      throw new Error("expected preview");
    }
    expect(preview.value.planId.startsWith("patch-")).toBe(true);
    expect(preview.value.targets[0]?.hunks[0]?.status).toBe("ready");
    expect(preview.value.targets[0]?.hunks[0]?.header).toBe("@@ -2,1 +2,1 @@");

    const conflictPreview = await workspace.preview(root, {
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 2, oldLines: ["nope"], newLines: ["TWO"] }],
        },
      ],
    });
    expect(conflictPreview.ok).toBe(true);
    if (!conflictPreview.ok) {
      throw new Error("expected conflict preview");
    }
    expect(conflictPreview.value.targets[0]?.hunks[0]?.status).toBe("conflict");
    expect(JSON.stringify(conflictPreview)).not.toContain("TWO");

    const applied = await workspace.apply(root, {
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }],
        },
      ],
      expectedPlanId: preview.value.planId,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      throw new Error("expected apply");
    }
    expect(applied.value.items[0]?.status).toBe("applied");
    const text = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    expect(text).toEqual({ ok: true, value: "one\nTWO\nthree\n" });
  });

  test("reports a conflict without relocating or echoing rejected text", async () => {
    const { fileSystem, workspace } = patcher();
    const result = await workspace.apply(root, {
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 2, oldLines: ["nope"], newLines: ["sk-live-SECRET"] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected plan result");
    }
    expect(result.value.items[0]).toMatchObject({
      status: "failed",
      error: { code: "conflict", hunkIndex: 0, found: ["two"] },
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
    const unchanged = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    expect(unchanged).toEqual({ ok: true, value: "one\ntwo\nthree\n" });
  });

  test("fail-before-effect applies nothing when a later target conflicts", async () => {
    const { fileSystem, workspace } = patcher();
    const result = await workspace.apply(root, {
      targets: [
        {
          path: "src/b.ts",
          hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["ALPHA"] }],
        },
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 1, oldLines: ["missing"], newLines: ["x"] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected plan result");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["unscheduled", "failed"]);
    const untouched = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(untouched).toEqual({ ok: true, value: "alpha\n" });
  });

  test("best-effort applies the valid target and skips a conflict", async () => {
    const { fileSystem, workspace } = patcher();
    const result = await workspace.apply(root, {
      policy: "best-effort",
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 1, oldLines: ["missing"], newLines: ["x"] }],
        },
        {
          path: "src/b.ts",
          hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["ALPHA"] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected best-effort");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["failed", "applied"]);
    const updated = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(updated).toEqual({ ok: true, value: "ALPHA\n" });
  });

  test("refuses digest mismatch, directories, escaping dests, and stale plans", async () => {
    const { workspace } = patcher();
    const digest = await workspace.apply(root, {
      targets: [
        {
          path: "src/a.ts",
          expectedDigest: digestFor("wrong\n"),
          hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }],
        },
      ],
    });
    expect(digest).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "digest-mismatch" } }] },
    });
    expect(
      await workspace.apply(root, {
        targets: [
          {
            path: "src/dir",
            hunks: [{ oldStart: 1, oldLines: ["x"], newLines: ["y"] }],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "not-a-file" } }] },
    });
    expect(
      await workspace.apply(root, {
        targets: [
          {
            path: "link",
            hunks: [{ oldStart: 1, oldLines: ["root"], newLines: ["x"] }],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "symlink-escape" } }] },
    });
    expect(
      await workspace.apply(root, {
        expectedPlanId: "patch-00000000-1",
        targets: [
          {
            path: "src/a.ts",
            hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }],
          },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "stale-plan" } });
  });

  test("keeps already-applied targets when later work is cancelled", async () => {
    const { fileSystem } = patcher();
    const controller = new AbortController();
    const aborting = {
      ...fileSystem,
      writeBytes: async (
        path: Parameters<typeof fileSystem.writeBytes>[0],
        bytes: Uint8Array,
        signal?: AbortSignal,
      ) => {
        const result = await fileSystem.writeBytes(path, bytes, signal);
        if (String(path).endsWith("/src/a.ts")) {
          controller.abort();
        }
        return result;
      },
    };
    const result = await createWorkspacePatcher({ fileSystem: aborting }).apply(
      root,
      {
        policy: "best-effort",
        targets: [
          {
            path: "src/a.ts",
            hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }],
          },
          {
            path: "src/b.ts",
            hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["BETA"] }],
          },
        ],
      },
      controller.signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected partial apply");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["applied", "cancelled"]);
    expect(result.value.rollback).toEqual({ status: "not-attempted", restored: [], failed: [] });
    const first = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    const second = await fileSystem.readText(localPath("/work/project/src/b.ts"), 1_024);
    expect(first).toEqual({ ok: true, value: "ONE\ntwo\nthree\n" });
    expect(second).toEqual({ ok: true, value: "alpha\n" });
  });

  test("rolls back an earlier apply when a later write fails", async () => {
    const { fileSystem } = patcher();
    const failing = {
      ...fileSystem,
      writeBytes: async (
        path: Parameters<typeof fileSystem.writeBytes>[0],
        bytes: Uint8Array,
        signal?: AbortSignal,
      ) => {
        if (String(path).endsWith("/src/b.ts")) {
          return {
            ok: false as const,
            error: {
              kind: "filesystem" as const,
              code: "io-failure" as const,
              path,
              operation: "write" as const,
            },
          };
        }
        return fileSystem.writeBytes(path, bytes, signal);
      },
    };
    const result = await createWorkspacePatcher({ fileSystem: failing }).apply(root, {
      policy: "best-effort",
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }],
        },
        {
          path: "src/b.ts",
          hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["BETA"] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected rollback");
    }
    expect(result.value.items.map((item) => item.status)).toEqual(["rolled-back", "failed"]);
    expect(result.value.rollback.status).toBe("complete");
    const restored = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    expect(restored).toEqual({ ok: true, value: "one\ntwo\nthree\n" });
  });

  test("does not overwrite a concurrent change during rollback", async () => {
    const { fileSystem } = patcher();
    const racing = {
      ...fileSystem,
      writeBytes: async (
        path: Parameters<typeof fileSystem.writeBytes>[0],
        bytes: Uint8Array,
        signal?: AbortSignal,
      ) => {
        if (String(path).endsWith("/src/b.ts")) {
          await fileSystem.writeBytes(
            localPath("/work/project/src/a.ts"),
            new TextEncoder().encode("clobbered\n"),
            signal,
          );
          return {
            ok: false as const,
            error: {
              kind: "filesystem" as const,
              code: "io-failure" as const,
              path,
              operation: "write" as const,
            },
          };
        }
        return fileSystem.writeBytes(path, bytes, signal);
      },
    };
    const result = await createWorkspacePatcher({ fileSystem: racing }).apply(root, {
      policy: "best-effort",
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 1, oldLines: ["one"], newLines: ["ONE"] }],
        },
        {
          path: "src/b.ts",
          hunks: [{ oldStart: 1, oldLines: ["alpha"], newLines: ["BETA"] }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected concurrent rollback failure");
    }
    expect(result.value.items[0]?.status).toBe("applied");
    expect(result.value.rollback).toMatchObject({
      status: "failed",
      failed: [{ index: 0, error: { code: "rollback-failed", reason: "concurrent-change" } }],
    });
    const current = await fileSystem.readText(localPath("/work/project/src/a.ts"), 1_024);
    expect(current).toEqual({ ok: true, value: "clobbered\n" });
  });

  test("reads applied changed regions and refuses mixed newlines", async () => {
    const { workspace } = patcher();
    const applied = await workspace.apply(root, {
      targets: [
        {
          path: "src/a.ts",
          hunks: [{ oldStart: 2, oldLines: ["two"], newLines: ["TWO"] }],
        },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.value.items[0]?.status !== "applied") {
      throw new Error("expected applied hunk");
    }
    const read = await workspace.readChangedRegions(root, {
      path: "src/a.ts",
      regions: applied.value.items[0].changedRegions,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected changed-region read");
    }
    expect(read.value.regions[0]).toEqual({
      range: { start: 2, end: 3 },
      lines: [{ number: 2, text: "TWO" }],
      truncated: false,
    });

    const mixed = patcher({
      "/work/project/src/mix.txt": { kind: "file", text: "a\r\nb\n" },
    });
    expect(
      await mixed.workspace.apply(root, {
        targets: [
          {
            path: "src/mix.txt",
            hunks: [{ oldStart: 1, oldLines: ["a"], newLines: ["A"] }],
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      value: { items: [{ status: "failed", error: { code: "unsupported" } }] },
    });
  });
});
