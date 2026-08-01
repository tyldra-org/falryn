/**
 * How the database registers itself with the local-data owner.
 *
 * The database is bytes in the `state` root, so retention has to measure it,
 * reset has to name it, and uninstall has to account for it. None of that
 * happens because the class appears in a vocabulary; it happens because this
 * owner registered it.
 */

import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
  type RootLayout,
} from "../domain/index.ts";
import { createOwnershipRegistry } from "./ownership.ts";
import { planReset, planUninstall } from "./removal.ts";
import { reportRetention } from "./retention.ts";
import { resolveRoots } from "./roots.ts";
import { SQLITE_STATE_OWNERSHIP } from "./sqlite-store.ts";

const OVERRIDES = {
  FALRYN_CONFIG_DIR: "/d/config",
  FALRYN_STATE_DIR: "/d/state",
  FALRYN_CACHE_DIR: "/d/cache",
  FALRYN_LOG_DIR: "/d/logs",
  FALRYN_TEMP_DIR: "/d/tmp",
  FALRYN_ARTIFACT_DIR: "/d/artifacts",
  FALRYN_EXPORT_DIR: "/d/exports",
};

/** A state root mid-run: the database plus the sidecars WAL leaves beside it. */
const TREE: Readonly<Record<string, InMemoryNode>> = {
  "/d": { kind: "directory" },
  "/d/state": { kind: "directory" },
  "/d/state/falryn.sqlite": { kind: "file", byteLength: 40_960 },
  "/d/state/falryn.sqlite-wal": { kind: "file", byteLength: 8_192 },
  "/d/state/falryn.sqlite-shm": { kind: "file", byteLength: 32_768 },
};

function layoutFor(): RootLayout {
  return resolveRoots({
    platform: "darwin",
    home: localPath("/Users/example"),
    environment: createStaticEnvironment(OVERRIDES),
  }).layout;
}

function inputsFor() {
  const registry = createOwnershipRegistry();
  registry.register(SQLITE_STATE_OWNERSHIP);
  return {
    fileSystem: createInMemoryFileSystem({ nodes: TREE }),
    layout: layoutFor(),
    registrations: registry.registrations(),
    unregistered: registry.unregistered(),
  };
}

describe("the sqliteState registration", () => {
  test("declares durable application state in the state root", () => {
    expect(SQLITE_STATE_OWNERSHIP).toEqual({
      ownershipClass: "sqliteState",
      owner: "sqlite-store",
      durability: "app-owned",
      removalPosture: "export-before-reset",
      roots: ["state"],
      external: false,
    });
  });

  test("is accepted by the registry", () => {
    const registry = createOwnershipRegistry();

    expect(registry.register(SQLITE_STATE_OWNERSHIP).ok).toBe(true);
    expect(registry.find("sqliteState")).toEqual(SQLITE_STATE_OWNERSHIP);
    expect(registry.unregistered()).not.toContain("sqliteState");
  });

  test("cannot be registered twice, because that would be two answers", () => {
    const registry = createOwnershipRegistry();
    registry.register(SQLITE_STATE_OWNERSHIP);

    const second = registry.register(SQLITE_STATE_OWNERSHIP);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error.code).toBe("class-already-registered");
  });
});

describe("retention reporting", () => {
  test("measures the database and its sidecars together", async () => {
    const report = await reportRetention({
      ...inputsFor(),
      policy: { byClass: {}, totalMaxBytes: null },
    });

    const usage = report.classes.find((entry) => entry.ownershipClass === "sqliteState");
    expect(usage).toMatchObject({
      owner: "sqlite-store",
      // A leftover `-wal` is disk a user is paying for; excluding it would
      // under-report the class by exactly the bytes a crashed run left behind.
      byteCount: 40_960 + 8_192 + 32_768,
      itemCount: 3,
      completeness: "complete",
    });
  });

  test("counts against the total quota rather than against a retention age", async () => {
    const report = await reportRetention({
      ...inputsFor(),
      policy: { byClass: {}, totalMaxBytes: 1_024 },
    });

    // Durable state has no `data.retention` entry: it is measured and weighed
    // against the total, never aged out.
    expect(report.totalPressure).toBe("over");
    expect(report.pressure.find((entry) => entry.ownershipClass === "sqliteState")).toMatchObject({
      bytes: "within",
      items: "within",
    });
  });
});

describe("removal planning", () => {
  test("names the class with its export-before-reset posture and exact paths", async () => {
    const plan = await planReset(inputsFor(), { classes: ["sqliteState"] });

    expect(plan.classes.find((entry) => entry.ownershipClass === "sqliteState")).toMatchObject({
      owner: "sqlite-store",
      removalPosture: "export-before-reset",
      action: "delete",
      reason: "selected",
      paths: [localPath("/d/state")],
      itemCount: 3,
    });
  });

  test("preserves the database when a reset did not select it", async () => {
    const plan = await planReset(inputsFor(), { classes: ["cache"] });

    expect(plan.classes.find((entry) => entry.ownershipClass === "sqliteState")).toMatchObject({
      action: "preserve",
      reason: "not-selected",
    });
  });

  test("includes the database in an uninstall", async () => {
    const plan = await planUninstall(inputsFor());

    expect(plan.classes.find((entry) => entry.ownershipClass === "sqliteState")).toMatchObject({
      action: "delete",
      removalPosture: "export-before-reset",
    });
  });
});
