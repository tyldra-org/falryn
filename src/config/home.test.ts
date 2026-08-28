import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  err,
  type FileSystemPort,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import {
  type ConfigurationHomeRoots,
  prepareConfigurationHomeForWrite,
  resolveConfigurationHome,
} from "./home.ts";

const CURRENT = localPath("/home/user/.falryn");
const LEGACY = localPath("/home/user/Library/Application Support/Falryn/config");

const ROOTS: ConfigurationHomeRoots = { current: CURRENT, legacy: LEGACY };

function fileSystem(nodes: Readonly<Record<string, InMemoryNode>> = {}) {
  return createInMemoryFileSystem({
    nodes: {
      "/home": { kind: "directory" },
      "/home/user": { kind: "directory" },
      "/home/user/Library": { kind: "directory" },
      "/home/user/Library/Application Support": { kind: "directory" },
      "/home/user/Library/Application Support/Falryn": { kind: "directory" },
      ...nodes,
    },
  });
}

describe("configuration home selection", () => {
  test("uses the current home when neither location contains data", async () => {
    const resolved = await resolveConfigurationHome(fileSystem(), ROOTS);
    expect(resolved).toMatchObject({ kind: "empty", root: CURRENT });
  });

  test("reads a populated legacy home without moving it", async () => {
    const fs = fileSystem({
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/falryn.jsonc`]: { kind: "file", text: "{}" },
    });

    const resolved = await resolveConfigurationHome(fs, ROOTS);

    expect(resolved).toMatchObject({ kind: "legacy", root: LEGACY });
    expect(fs.paths()).toContain(LEGACY);
    expect(fs.paths()).not.toContain(CURRENT);
  });

  test("refuses two populated homes instead of merging them", async () => {
    const fs = fileSystem({
      [CURRENT]: { kind: "directory" },
      [`${CURRENT}/falryn.jsonc`]: { kind: "file", text: "{}" },
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/profiles.jsonc`]: { kind: "file", text: "{}" },
    });

    expect(await resolveConfigurationHome(fs, ROOTS)).toEqual({
      kind: "conflict",
      currentRoot: CURRENT,
      legacyRoot: LEGACY,
    });
  });

  test("an explicit configuration root has no legacy lookup", async () => {
    const roots = { current: localPath("/home/user/custom"), legacy: null };
    const resolved = await resolveConfigurationHome(fileSystem(), roots);
    expect(resolved).toMatchObject({ kind: "empty", root: roots.current, legacyRoot: null });
  });
});

describe("configuration home migration", () => {
  test("moves the complete legacy directory before the first write", async () => {
    const fs = fileSystem({
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/falryn.jsonc`]: { kind: "file", text: "{}" },
      [`${LEGACY}/profiles`]: { kind: "directory" },
      [`${LEGACY}/profiles/work.jsonc`]: { kind: "file", text: "{}" },
    });

    expect(await prepareConfigurationHomeForWrite(fs, ROOTS)).toEqual({
      kind: "ready",
      root: CURRENT,
      migrated: true,
    });
    expect(fs.paths()).toContain(localPath(`${CURRENT}/falryn.jsonc`));
    expect(fs.paths()).toContain(localPath(`${CURRENT}/profiles/work.jsonc`));
    expect(fs.paths()).not.toContain(LEGACY);
  });

  test("removes an empty current directory before moving legacy data", async () => {
    const fs = fileSystem({
      [CURRENT]: { kind: "directory" },
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/falryn.jsonc`]: { kind: "file", text: "{}" },
    });

    const migrated = await prepareConfigurationHomeForWrite(fs, ROOTS);
    expect(migrated).toMatchObject({ kind: "ready", migrated: true });
    expect(fs.paths()).toContain(localPath(`${CURRENT}/falryn.jsonc`));
  });

  test("cancellation leaves legacy bytes untouched", async () => {
    const fs = fileSystem({
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/falryn.jsonc`]: { kind: "file", text: "{}" },
    });
    const controller = new AbortController();
    controller.abort();

    expect(await prepareConfigurationHomeForWrite(fs, ROOTS, controller.signal)).toEqual({
      kind: "cancelled",
    });
    expect(fs.paths()).toContain(localPath(`${LEGACY}/falryn.jsonc`));
    expect(fs.paths()).not.toContain(CURRENT);
  });

  test("a failed directory rename preserves the complete legacy home", async () => {
    const base = fileSystem({
      [LEGACY]: { kind: "directory" },
      [`${LEGACY}/falryn.jsonc`]: { kind: "file", text: "{}" },
      [`${LEGACY}/profiles`]: { kind: "directory" },
      [`${LEGACY}/profiles/work.jsonc`]: { kind: "file", text: "{}" },
    });
    const failing: FileSystemPort = {
      ...base,
      renameEntry: async (from, _to, signal) =>
        signal?.aborted === true
          ? err({ kind: "filesystem", code: "cancelled", path: from, operation: "rename" })
          : err({ kind: "filesystem", code: "cross-device", path: from, operation: "rename" }),
    };

    expect(await prepareConfigurationHomeForWrite(failing, ROOTS)).toEqual({
      kind: "unavailable",
      path: LEGACY,
      code: "cross-device",
    });
    expect(base.paths()).toContain(localPath(`${LEGACY}/falryn.jsonc`));
    expect(base.paths()).toContain(localPath(`${LEGACY}/profiles/work.jsonc`));
    expect(base.paths()).not.toContain(CURRENT);
  });
});
