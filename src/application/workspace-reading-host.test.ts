/**
 * Host-backed workspace read failures (#60).
 *
 * Exercises symlink escape, binary bytes, large-file bounds, stale revision,
 * and cancellation through the public workspace reader against a real temporary
 * directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

import { type FileSystemPort, localPath, parseLocalPath } from "../domain/index.ts";
import { createHostFileSystem } from "../integrations/host-filesystem.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const host = createHostFileSystem();
let root = localPath("/tmp");

function at(...segments: readonly string[]): ReturnType<typeof localPath> {
  return localPath([root, ...segments].join("/"));
}

beforeEach(async () => {
  const created = await fs.mkdtemp(`${tmpdir()}/falryn-read-`);
  const parsed = parseLocalPath(created);
  if (!parsed.ok) {
    throw new Error(`temporary root was not a usable path: ${parsed.error.code}`);
  }
  const real = await host.realPath(parsed.value);
  if (!real.ok) {
    throw new Error(`temporary root could not be resolved: ${real.error.code}`);
  }
  root = real.value;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("host workspace reader failures", () => {
  test("follows an in-workspace symlink and refuses one that leaves the root", async () => {
    await fs.writeFile(at("inside.ts"), "hello\n");
    await fs.symlink(at("inside.ts"), at("alias.ts"));
    await fs.symlink(tmpdir(), at("out"));
    const workspace = createWorkspaceReader(host);

    const followed = await workspace.read(root, "alias.ts");
    expect(followed.ok).toBe(true);
    if (!followed.ok) {
      throw new Error("expected in-workspace symlink");
    }
    expect(followed.value.lines[0]?.text).toBe("hello");

    expect(await workspace.read(root, "out")).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("refuses binary text, keeps exact bytes, and bounds a large file", async () => {
    await fs.writeFile(at("secret.bin"), Buffer.from("sk-live-SECRET\0", "utf8"));
    await fs.writeFile(at("huge.ts"), "0123456789abcdef");
    const workspace = createWorkspaceReader(host);

    const text = await workspace.read(root, "secret.bin");
    expect(text).toEqual({ ok: false, error: { code: "binary" } });
    expect(JSON.stringify(text)).not.toContain("sk-live-SECRET");

    const bytes = await workspace.readBytes(root, "secret.bin");
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) {
      throw new Error("expected binary bytes");
    }
    expect([...bytes.value.bytes.slice(-1)]).toEqual([0]);

    const oversized = await workspace.read(root, "huge.ts", undefined, { maxFileBytes: 4 });
    expect(oversized.ok).toBe(false);
    if (oversized.ok) {
      throw new Error("expected oversized");
    }
    expect(oversized.error.code).toBe("oversized");
  });

  test("reports a host file that changes between snapshot and confirmation as stale", async () => {
    await fs.writeFile(at("changing.ts"), "before");
    let stats = 0;
    const changing: FileSystemPort = {
      ...host,
      stat: async (path, signal) => {
        const result = await host.stat(path, signal);
        stats += 1;
        if (result.ok && result.value?.kind === "file" && stats === 2) {
          await fs.writeFile(path, "after-change");
          return host.stat(path, signal);
        }
        return result;
      },
    };
    expect(
      await createWorkspaceReader(changing).read(root, "changing.ts", undefined, {
        maxStaleRetries: 0,
      }),
    ).toEqual({
      ok: false,
      error: { code: "stale", attempts: 1 },
    });
  });

  test("honors an already-aborted signal without reading host bytes", async () => {
    await fs.writeFile(at("note.ts"), "hello\n");
    expect(
      await createWorkspaceReader(host).read(
        root,
        "note.ts",
        undefined,
        undefined,
        AbortSignal.abort(),
      ),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
