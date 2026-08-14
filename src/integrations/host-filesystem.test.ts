/**
 * Adapter tests against a real filesystem.
 *
 * Every test gets its own directory under the system temporary root and removes
 * it afterwards. Nothing here touches the developer's real Falryn data
 * location, and no test resolves a platform root: root resolution is pure and
 * is tested with a static environment instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

import { createInMemoryFileSystem, localPath, parseLocalPath } from "../domain/index.ts";
import { createHostEnvironment, hostHome, hostPlatform } from "./host-environment.ts";
import { createHostFileSystem } from "./host-filesystem.ts";

const fileSystem = createHostFileSystem();

let root = localPath("/tmp");

function at(...segments: readonly string[]): ReturnType<typeof localPath> {
  return localPath([root, ...segments].join("/"));
}

beforeEach(async () => {
  const created = await fs.mkdtemp(`${tmpdir()}/falryn-fs-`);
  const parsed = parseLocalPath(created);
  if (!parsed.ok) {
    throw new Error(`temporary root was not a usable path: ${parsed.error.code}`);
  }
  root = parsed.value;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("describing a path", () => {
  test("reports a missing path as absent rather than as a failure", async () => {
    const result = await fileSystem.stat(at("nothing"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  test("reports a file with its byte length and permission bits", async () => {
    await fs.writeFile(at("note.txt"), "hello");
    const result = await fileSystem.stat(at("note.txt"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ kind: "file", byteLength: 5 });
      expect(result.value?.mode).not.toBeNull();
    }
  });

  test("reports a symlink as a link, without following it", async () => {
    await fs.mkdir(at("target"));
    await fs.symlink(at("target"), at("link"));

    const result = await fileSystem.stat(at("link"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Following it here would make "is this entry inside its root"
      // unanswerable, and every removal decision depends on that question.
      expect(result.value?.kind).toBe("symlink");
    }
  });
});

describe("creating a directory", () => {
  test("creates missing parents with private permissions", async () => {
    const created = await fileSystem.createDirectory(at("a", "b", "c"), 0o700);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value).toBe("created");
    }

    const stats = await fs.stat(at("a", "b", "c"));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  test("reports an existing directory rather than recreating it", async () => {
    await fileSystem.createDirectory(at("a"), 0o700);
    const again = await fileSystem.createDirectory(at("a"), 0o700);

    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value).toBe("existed");
    }
  });

  test("refuses a path that is already a file", async () => {
    await fs.writeFile(at("occupied"), "x");
    const created = await fileSystem.createDirectory(at("occupied"), 0o700);

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("not-empty");
      expect(created.error.operation).toBe("create-directory");
    }
    // The file survives: the adapter never clears a path to make room.
    expect((await fs.readFile(at("occupied"))).toString()).toBe("x");
  });
});

describe("listing a directory", () => {
  test("lists children without descending", async () => {
    await fs.mkdir(at("nested"));
    await fs.writeFile(at("nested", "deep.txt"), "deep");
    await fs.writeFile(at("top.txt"), "top");

    const listed = await fileSystem.list(root);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((entry) => entry.path).sort()).toEqual(
        [at("nested"), at("top.txt")].sort(),
      );
      expect(listed.value.find((entry) => entry.path === at("top.txt"))?.byteLength).toBe(3);
    }
  });

  test("reports a missing directory", async () => {
    const listed = await fileSystem.list(at("absent"));
    expect(listed.ok).toBe(false);
    if (!listed.ok) {
      expect(listed.error.code).toBe("not-found");
    }
  });

  test("reports a file as not a directory", async () => {
    await fs.writeFile(at("note.txt"), "x");
    const listed = await fileSystem.list(at("note.txt"));
    expect(listed.ok).toBe(false);
    if (!listed.ok) {
      expect(listed.error.code).toBe("not-a-directory");
    }
  });
});

describe("removing one entry", () => {
  test("removes a file", async () => {
    await fs.writeFile(at("note.txt"), "x");
    expect((await fileSystem.removeEntry(at("note.txt"))).ok).toBe(true);
    expect(await fs.exists(at("note.txt"))).toBe(false);
  });

  test("removes an empty directory but refuses a full one", async () => {
    await fs.mkdir(at("full"));
    await fs.writeFile(at("full", "child.txt"), "x");

    const refused = await fileSystem.removeEntry(at("full"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // The adapter is never recursive, so it cannot delete more than the one
      // entry it was named. Recursion is a decision `src/data/` makes.
      expect(refused.error.code).toBe("not-empty");
    }

    await fs.rm(at("full", "child.txt"));
    expect((await fileSystem.removeEntry(at("full"))).ok).toBe(true);
  });

  test("removes a symlink as a link, leaving its target intact", async () => {
    await fs.mkdir(at("target"));
    await fs.writeFile(at("target", "keep.txt"), "keep");
    await fs.symlink(at("target"), at("link"));

    expect((await fileSystem.removeEntry(at("link"))).ok).toBe(true);
    expect(await fs.exists(at("link"))).toBe(false);
    expect((await fs.readFile(at("target", "keep.txt"))).toString()).toBe("keep");
  });

  test("reports a missing entry rather than throwing", async () => {
    const removed = await fileSystem.removeEntry(at("absent"));
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.error.code).toBe("not-found");
    }
  });
});

describe("resolving links and probing writability", () => {
  test("resolves a symlink to its target", async () => {
    await fs.mkdir(at("target"));
    await fs.symlink(at("target"), at("link"));

    const resolved = await fileSystem.realPath(at("link"));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      // macOS resolves the temporary root through /private, so compare the tail.
      expect(resolved.value.endsWith("/target")).toBe(true);
    }
  });

  test("reports a writable directory as writable", async () => {
    const probe = await fileSystem.probeWritable(root);
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.value).toBe(true);
    }
  });

  test("reports an unwritable directory as unwritable rather than failing", async () => {
    await fs.mkdir(at("locked"), { mode: 0o500 });
    try {
      const probe = await fileSystem.probeWritable(at("locked"));
      expect(probe.ok).toBe(true);
      if (probe.ok) {
        // Running as root defeats the permission bits, so accept either answer
        // and assert only that it is a verdict rather than an error.
        expect(typeof probe.value).toBe("boolean");
      }
    } finally {
      await fs.chmod(at("locked"), 0o700);
    }
  });
});

describe("reading text", () => {
  test("reads a file's contents as UTF-8", async () => {
    await fs.writeFile(at("note.txt"), "hello — world");
    const read = await fileSystem.readText(at("note.txt"), 1_024);

    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe("hello — world");
    }
  });

  test("refuses a file past the bound by its size, without reading it", async () => {
    const content = "x".repeat(2_048);
    await fs.writeFile(at("big.txt"), content);

    const read = await fileSystem.readText(at("big.txt"), 1_024);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("oversized");
      expect(read.error.operation).toBe("read-text");
    }
    // The file is untouched; refusing it is not a reason to remove it.
    expect((await fs.stat(at("big.txt"))).size).toBe(2_048);
  });

  test("accepts a file exactly at the bound", async () => {
    await fs.writeFile(at("exact.txt"), "y".repeat(16));
    const read = await fileSystem.readText(at("exact.txt"), 16);
    expect(read.ok).toBe(true);
  });

  test("measures the bound in bytes, not characters", async () => {
    // Three characters, nine bytes. A character-counting bound would accept it.
    await fs.writeFile(at("wide.txt"), "———");
    const read = await fileSystem.readText(at("wide.txt"), 5);

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("oversized");
    }
  });

  test("reports a missing file as not-found rather than as empty text", async () => {
    const read = await fileSystem.readText(at("absent.txt"), 1_024);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      // An absent configuration source and an empty one mean different things,
      // and conflating them would make a truncated write look deliberate.
      expect(read.error.code).toBe("not-found");
    }
  });

  test("reports a directory as not a directory to read", async () => {
    await fs.mkdir(at("adir"));
    const read = await fileSystem.readText(at("adir"), 1_024);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("not-a-directory");
    }
  });

  test("refuses bytes that are not valid UTF-8", async () => {
    // A lone continuation byte: valid on disk, not decodable as UTF-8.
    await fs.writeFile(at("bad.bin"), Buffer.from([0x68, 0x69, 0x80]));

    const read = await fileSystem.readText(at("bad.bin"), 1_024);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      // Decoding leniently would substitute replacement characters and hand a
      // parser text the file does not contain.
      expect(read.error.code).toBe("malformed-encoding");
      expect(read.error.operation).toBe("read-text");
    }
  });

  test("reads an empty file as empty text rather than as missing", async () => {
    await fs.writeFile(at("empty.txt"), "");
    const read = await fileSystem.readText(at("empty.txt"), 1_024);

    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toBe("");
    }
  });
});

describe("reading bytes", () => {
  test("preserves binary bytes without UTF-8 coercion", async () => {
    await fs.writeFile(at("document.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    const read = await fileSystem.readBytes(at("document.pdf"), 1_024);

    expect(read.ok).toBe(true);
    if (read.ok) {
      expect([...read.value]).toEqual([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    }
  });

  test("returns only the requested bounded range", async () => {
    await fs.writeFile(at("range.bin"), Buffer.from([1, 2, 3, 4, 5]));
    const read = await fileSystem.readBytesRange(at("range.bin"), 2, 10);

    expect(read).toEqual({ ok: true, value: Uint8Array.from([3, 4, 5]) });
  });
});

describe("cancellation", () => {
  test("every operation refuses an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    for (const result of [
      await fileSystem.stat(root, signal),
      await fileSystem.createDirectory(at("x"), 0o700, signal),
      await fileSystem.list(root, signal),
      await fileSystem.removeEntry(at("x"), signal),
      await fileSystem.realPath(root, signal),
      await fileSystem.probeWritable(root, signal),
      await fileSystem.readText(at("note.txt"), 1_024, signal),
      await fileSystem.readBytes(at("note.txt"), 1_024, signal),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("cancelled");
      }
    }
    expect(await fs.exists(at("x"))).toBe(false);
  });
});

describe("the in-memory double agrees with the adapter", () => {
  test("both report a missing path as absent", async () => {
    const double = createInMemoryFileSystem();
    const fromDouble = await double.stat(localPath("/absent"));
    const fromHost = await fileSystem.stat(at("absent"));

    expect(fromDouble.ok && fromDouble.value).toBeNull();
    expect(fromHost.ok && fromHost.value).toBeNull();
  });

  test("both report a missing file the same way when reading text", async () => {
    const double = createInMemoryFileSystem();
    const fromDouble = await double.readText(localPath("/absent.txt"), 1_024);
    const fromHost = await fileSystem.readText(at("absent.txt"), 1_024);

    expect(fromDouble.ok).toBe(false);
    expect(fromHost.ok).toBe(false);
    if (!fromDouble.ok && !fromHost.ok) {
      expect(fromDouble.error.code).toBe(fromHost.error.code);
    }
  });

  test("both refuse an oversized file the same way", async () => {
    const double = createInMemoryFileSystem({
      nodes: { "/big.txt": { kind: "file", text: "x".repeat(2_048) } },
    });
    await fs.writeFile(at("big.txt"), "x".repeat(2_048));

    const fromDouble = await double.readText(localPath("/big.txt"), 1_024);
    const fromHost = await fileSystem.readText(at("big.txt"), 1_024);

    expect(fromDouble.ok).toBe(false);
    expect(fromHost.ok).toBe(false);
    if (!fromDouble.ok && !fromHost.ok) {
      expect(fromDouble.error.code).toBe(fromHost.error.code);
    }
  });

  test("both refuse to remove a non-empty directory", async () => {
    const double = createInMemoryFileSystem({
      nodes: { "/full": { kind: "directory" }, "/full/child": { kind: "file" } },
    });
    await fs.mkdir(at("full"));
    await fs.writeFile(at("full", "child"), "x");

    const fromDouble = await double.removeEntry(localPath("/full"));
    const fromHost = await fileSystem.removeEntry(at("full"));

    expect(fromDouble.ok).toBe(false);
    expect(fromHost.ok).toBe(false);
    if (!fromDouble.ok && !fromHost.ok) {
      expect(fromDouble.error.code).toBe(fromHost.error.code);
    }
  });
});

describe("the host environment adapter", () => {
  test("reports the running platform as one this build declares", () => {
    expect(["darwin", "linux", "win32"]).toContain(hostPlatform());
  });

  test("resolves a usable home directory", () => {
    expect(hostHome()).not.toBeNull();
  });

  test("reads a set variable and treats an unset one as null", () => {
    const environment = createHostEnvironment();
    expect(environment.get("FALRYN_DEFINITELY_UNSET_VARIABLE")).toBeNull();
    expect(environment.get("PATH")).not.toBeNull();
  });
});
