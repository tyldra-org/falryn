import { describe, expect, test } from "bun:test";

import { DIAGNOSTICS_OWNERSHIP } from "../application/index.ts";
import { CONFIGURATION_OWNERSHIP } from "../config/index.ts";
import { RETENTION_CLASSES } from "../config/keys.ts";
import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
  OWNERSHIP_CLASSES,
  type RetentionPolicy,
  type RootLayout,
} from "../domain/index.ts";
import { CREDENTIAL_REFERENCE_OWNERSHIP, TEMPORARY_INGEST_OWNERSHIP } from "./ownership.ts";
import { MAX_MEASURED_ENTRIES, measureSubtree, owningRoot, reportRetention } from "./retention.ts";
import { resolveRoots } from "./roots.ts";

const OVERRIDES = {
  FALRYN_CONFIG_DIR: "/d/config",
  FALRYN_LOG_DIR: "/d/logs",
  FALRYN_TEMP_DIR: "/d/tmp",
};

function layoutFor(): RootLayout {
  return resolveRoots({
    platform: "darwin",
    home: localPath("/Users/example"),
    environment: createStaticEnvironment(OVERRIDES),
  }).layout;
}

const TREE: Readonly<Record<string, InMemoryNode>> = {
  "/d/config": { kind: "directory" },
  "/d/config/settings.jsonc": { kind: "file", byteLength: 120 },
  "/d/logs": { kind: "directory" },
  "/d/logs/today": { kind: "directory" },
  "/d/logs/today/run.log": { kind: "file", byteLength: 400 },
  "/d/logs/old.log": { kind: "file", byteLength: 100 },
  "/d/tmp": { kind: "directory" },
};

const REGISTRATIONS = [
  CONFIGURATION_OWNERSHIP,
  DIAGNOSTICS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
];

const UNREGISTERED = OWNERSHIP_CLASSES.filter(
  (ownershipClass) =>
    !REGISTRATIONS.some((registration) => registration.ownershipClass === ownershipClass),
);

function report(policy: RetentionPolicy, nodes = TREE) {
  return reportRetention({
    fileSystem: createInMemoryFileSystem({ nodes }),
    layout: layoutFor(),
    registrations: REGISTRATIONS,
    unregistered: UNREGISTERED,
    policy,
  });
}

const NO_LIMITS: RetentionPolicy = { byClass: {}, totalMaxBytes: null };

describe("measuring usage", () => {
  test("reports bytes and item counts per class", async () => {
    const result = await report(NO_LIMITS);
    const logs = result.classes.find((usage) => usage.ownershipClass === "logs");

    expect(logs).toMatchObject({
      owner: "diagnostics",
      byteCount: 500,
      itemCount: 3,
      completeness: "complete",
    });
    expect(result.totalBytes).toBe(620);
  });

  test("a root that was never created holds nothing, completely", async () => {
    const result = await report(NO_LIMITS, { "/d/logs": { kind: "directory" } });
    const configuration = result.classes.find((usage) => usage.ownershipClass === "configuration");
    expect(configuration).toMatchObject({ byteCount: 0, itemCount: 0, completeness: "complete" });
  });

  test("an external class is named without its store being opened", async () => {
    const result = await report(NO_LIMITS);
    const credentials = result.classes.find((usage) => usage.ownershipClass === "credentials");

    expect(credentials).toMatchObject({ byteCount: 0, itemCount: 0, roots: [] });
  });

  test("classes no owner registered are reported as such", async () => {
    const result = await report(NO_LIMITS);
    expect(result.unregistered).toContain("artifacts");
    expect(result.unregistered).not.toContain("logs");
  });

  test("a symlink counts as one item and is never followed", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/d/logs": { kind: "directory" },
        "/d/logs/link": { kind: "symlink", target: "/elsewhere" },
        "/elsewhere": { kind: "directory" },
        "/elsewhere/huge.bin": { kind: "file", byteLength: 1_000_000 },
      },
    });
    const measured = await measureSubtree(fileSystem, localPath("/d/logs"), {
      remaining: MAX_MEASURED_ENTRIES,
    });

    expect(measured).toEqual({ byteCount: 0, itemCount: 1, completeness: "complete" });
  });

  test("a walk that hits its bound says the measurement is partial", async () => {
    const nodes: Record<string, InMemoryNode> = { "/d/logs": { kind: "directory" } };
    for (let index = 0; index < 10; index += 1) {
      nodes[`/d/logs/file-${index}.log`] = { kind: "file", byteLength: 10 };
    }
    const fileSystem = createInMemoryFileSystem({ nodes });

    const measured = await measureSubtree(fileSystem, localPath("/d/logs"), { remaining: 4 });

    expect(measured.completeness).toBe("partial");
    expect(measured.itemCount).toBeLessThan(10);
  });

  test("cancellation reports a partial measurement rather than a total", async () => {
    const controller = new AbortController();
    controller.abort();
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });

    const measured = await measureSubtree(
      fileSystem,
      localPath("/d/logs"),
      { remaining: MAX_MEASURED_ENTRIES },
      controller.signal,
    );

    expect(measured.completeness).toBe("partial");
  });
});

describe("quota pressure", () => {
  test("reports within, at, and over against declared budgets", async () => {
    const result = await report({
      byClass: {
        logs: { maxBytes: 500, maxItems: 2 },
        configuration: { maxBytes: 1_000, maxItems: null },
      },
      totalMaxBytes: 100,
    });

    const logs = result.pressure.find((entry) => entry.ownershipClass === "logs");
    expect(logs).toEqual({ ownershipClass: "logs", bytes: "at", items: "over" });

    const configuration = result.pressure.find((entry) => entry.ownershipClass === "configuration");
    expect(configuration).toEqual({
      ownershipClass: "configuration",
      bytes: "within",
      items: "within",
    });

    expect(result.totalPressure).toBe("over");
  });

  test("a class with no budget is within, never over", async () => {
    const result = await report(NO_LIMITS);
    for (const entry of result.pressure) {
      expect(entry.bytes).toBe("within");
      expect(entry.items).toBe("within");
    }
  });

  test("a partial measurement yields no verdict at all", async () => {
    const nodes: Record<string, InMemoryNode> = { "/d/logs": { kind: "directory" } };
    for (let index = 0; index < MAX_MEASURED_ENTRIES + 10; index += 1) {
      nodes[`/d/logs/file-${index}.log`] = { kind: "file", byteLength: 1 };
    }

    const result = await report(
      { byClass: { logs: { maxBytes: 1, maxItems: 1 } }, totalMaxBytes: 1 },
      nodes,
    );
    const logs = result.pressure.find((entry) => entry.ownershipClass === "logs");

    // Reporting `over` from an incomplete walk would be luck; reporting `within`
    // would be a fabrication. Neither is a verdict this data supports.
    expect(logs).toEqual({ ownershipClass: "logs", bytes: "unmeasured", items: "unmeasured" });
    expect(result.totalPressure).toBe("unmeasured");
  });

  test("reporting never deletes anything", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const before = fileSystem.paths();

    await reportRetention({
      fileSystem,
      layout: layoutFor(),
      registrations: REGISTRATIONS,
      unregistered: UNREGISTERED,
      policy: { byClass: { logs: { maxBytes: 0, maxItems: 0 } }, totalMaxBytes: 0 },
    });

    expect(fileSystem.paths()).toEqual(before);
  });
});

describe("root ownership of a path", () => {
  test("finds the root a path belongs to", () => {
    const layout = layoutFor();
    expect(owningRoot(layout, localPath("/d/logs/today/run.log"))?.root).toBe("logs");
    expect(owningRoot(layout, localPath("/Users/example/project"))).toBeNull();
  });

  test("a sibling directory with a shared prefix is not inside", () => {
    const layout = layoutFor();
    expect(owningRoot(layout, localPath("/d/logs-old/run.log"))).toBeNull();
  });
});

describe("agreement with the configuration key catalog", () => {
  test("every configurable retention class is an ownership class", () => {
    // The retention map's keys and the ownership vocabulary are declared in two
    // areas. If they drift, a user configures a budget for a class that no
    // measurement will ever report.
    for (const retentionClass of RETENTION_CLASSES) {
      expect(OWNERSHIP_CLASSES).toContain(retentionClass);
    }
  });
});
