import { expect, test } from "bun:test";
import { localPath } from "./contracts.ts";
import { createInMemoryFileSystem } from "./in-memory.ts";

test("conditional ranges preserve the same inspected-revision contract in memory", async () => {
  const files = createInMemoryFileSystem();
  const path = localPath("/source.md");
  files.put(path, { kind: "file", text: "before", revision: "first" });
  const before = await files.stat(path);
  if (!before.ok || !before.value) throw new Error("fixture stat");
  const condition = { expectedRevision: before.value.revision };
  expect(await files.readBytesRange(path, 0, 7, undefined, condition)).toEqual({
    ok: true,
    value: new TextEncoder().encode("before"),
  });
  files.put(path, { kind: "file", text: "after!", revision: "second" });
  expect(await files.readBytesRange(path, 0, 7, undefined, condition)).toMatchObject({
    ok: false,
    error: { code: "stale-read" },
  });
});
