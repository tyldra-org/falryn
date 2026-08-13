import { describe, expect, test } from "bun:test";
import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

function reader() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "one\ntwo\nthree\n" },
      "/work/project/src/b.ts": { kind: "file", text: "bbb" },
      "/work/project/src/alias.ts": { kind: "symlink", target: "/work/project/src/a.ts" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/work/project/secret.bin": { kind: "file", text: "sk-live-SECRET\0" },
      "/work/project/binary.pdf": {
        kind: "file",
        bytes: Uint8Array.from([37, 80, 68, 70, 0, 255]),
      },
      "/work/project/huge.ts": { kind: "file", text: "0123456789abcdef" },
      "/etc/passwd": { kind: "file", text: "root" },
    },
  });
  return createWorkspaceReader(fs);
}

describe("createWorkspaceReader", () => {
  test("reads numbered text for one file", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/a.ts");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines).toEqual([
      { number: 1, text: "one" },
      { number: 2, text: "two" },
      { number: 3, text: "three" },
    ]);
    expect(read.value.newline).toBe("lf");
  });

  test("applies a line range", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/a.ts", {
      kind: "line",
      range: { start: 2, end: 2 },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines).toEqual([{ number: 2, text: "two" }]);
    expect(read.value.truncated).toBe(true);
  });

  test("follows an in-workspace symlink to file bytes", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "src/alias.ts");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected read");
    }
    expect(read.value.lines[0]?.text).toBe("one");
    expect(read.value.bound.logical).toBe("src/a.ts");
  });

  test("refuses a symlink that leaves the root", async () => {
    const workspace = reader();
    expect(await workspace.read(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("refuses a directory", async () => {
    const workspace = reader();
    expect(await workspace.read(root, "src")).toEqual({
      ok: false,
      error: { code: "not-a-file" },
    });
  });

  test("refuses binary content without echoing secrets", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "secret.bin");
    expect(read).toEqual({ ok: false, error: { code: "binary" } });
    expect(JSON.stringify(read)).not.toContain("sk-live-SECRET");
  });

  test("reads bounded binary bytes without coercing them to text", async () => {
    const workspace = reader();
    const read = await workspace.readBytes(root, "binary.pdf");
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected binary read");
    }
    expect([...read.value.bytes]).toEqual([37, 80, 68, 70, 0, 255]);
    expect(read.value.byteLength).toBe(6);
  });

  test("refuses an oversized file without returning bytes", async () => {
    const workspace = reader();
    const read = await workspace.read(root, "huge.ts", undefined, { maxFileBytes: 4 });
    expect(read.ok).toBe(false);
    if (read.ok) {
      throw new Error("expected oversized");
    }
    expect(read.error.code).toBe("oversized");
    expect(JSON.stringify(read)).not.toContain("0123456789abcdef");
  });

  test("reads many files in input order", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/b.ts" }, { path: "src/a.ts" }], {
      maxConcurrency: 2,
    });
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items.map((item) => item.index)).toEqual([0, 1]);
    expect(many.value.items[0]?.status).toBe("read");
    expect(many.value.items[1]?.status).toBe("read");
  });

  test("reuses one canonical read for aliases", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/a.ts" }, { path: "src/alias.ts" }]);
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items.every((item) => item.status === "read")).toBe(true);
  });

  test("leaves later targets unscheduled when the aggregate budget is spent", async () => {
    const workspace = reader();
    const many = await workspace.readMany(root, [{ path: "src/a.ts" }, { path: "src/b.ts" }], {
      maxAggregateBytes: 14,
      maxConcurrency: 1,
    });
    expect(many.ok).toBe(true);
    if (!many.ok) {
      throw new Error("expected readMany");
    }
    expect(many.value.items[0]?.status).toBe("read");
    expect(many.value.items[1]?.status).toBe("unscheduled");
  });

  test("honors cancellation", async () => {
    const workspace = reader();
    expect(
      await workspace.read(root, "src/a.ts", undefined, undefined, AbortSignal.abort()),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
