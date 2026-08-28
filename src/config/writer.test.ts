import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor } from "../application/index.ts";
import { createInMemoryFileSystem, type InMemoryNode, localPath } from "../domain/index.ts";
import { enumKey } from "./declaration.ts";
import { V0_1_CONFIGURATION_KEYS, V0_1_CROSS_FIELD_RULES } from "./keys.ts";
import { createConfigurationRegistry } from "./registry.ts";
import { CONFIGURATION_FILE_NAME } from "./sources.ts";
import { writeConfigurationKey } from "./writer.ts";

const CONFIG_ROOT = localPath("/d/config");
const LEGACY_CONFIG_ROOT = localPath("/d/legacy-config");
const USER_FILE = `/d/config/${CONFIGURATION_FILE_NAME}`;

function file(text: string): InMemoryNode {
  return { kind: "file", text };
}

function harness(nodes: Readonly<Record<string, InMemoryNode>> = {}) {
  const registry = createConfigurationRegistry({
    declarations: V0_1_CONFIGURATION_KEYS,
    crossFieldRules: V0_1_CROSS_FIELD_RULES,
    redactor: createRuntimeRedactor(),
  });
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/d": { kind: "directory" },
      "/d/config": { kind: "directory" },
      ...nodes,
    },
  });
  return { registry, fileSystem };
}

describe("writeConfigurationKey", () => {
  test("migrates the legacy home before a user write", async () => {
    const legacyFile = "/d/legacy-config/falryn.jsonc";
    const { registry, fileSystem } = harness({
      "/d/legacy-config": { kind: "directory" },
      [legacyFile]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "info" } }`),
      "/d/legacy-config/profiles": { kind: "directory" },
      "/d/legacy-config/profiles/work.jsonc": file(`{ "schemaVersion": 1 }`),
    });

    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      legacyConfigurationRoot: LEGACY_CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "warn",
    });

    expect(outcome.kind).toBe("written");
    expect(fileSystem.paths()).toContain(localPath(USER_FILE));
    expect(fileSystem.paths()).toContain(localPath("/d/config/profiles/work.jsonc"));
    expect(fileSystem.paths()).not.toContain(LEGACY_CONFIG_ROOT);
  });

  test("refuses a write when both configuration homes contain data", async () => {
    const { registry, fileSystem } = harness({
      [USER_FILE]: file(`{ "schemaVersion": 1 }`),
      "/d/legacy-config": { kind: "directory" },
      "/d/legacy-config/falryn.jsonc": file(`{ "schemaVersion": 1 }`),
    });

    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      legacyConfigurationRoot: LEGACY_CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "warn",
    });

    expect(outcome).toMatchObject({ kind: "rejected" });
    expect(fileSystem.paths()).toContain(localPath("/d/legacy-config/falryn.jsonc"));
    expect(fileSystem.paths()).toContain(localPath(USER_FILE));
  });

  test("keeps project writes independent of a user-home conflict", async () => {
    const { registry, fileSystem } = harness({
      [USER_FILE]: file(`{ "schemaVersion": 1 }`),
      "/d/legacy-config": { kind: "directory" },
      "/d/legacy-config/falryn.jsonc": file(`{ "schemaVersion": 1 }`),
      "/workspace": { kind: "directory" },
    });

    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      legacyConfigurationRoot: LEGACY_CONFIG_ROOT,
      workspaceRoot: localPath("/workspace"),
      profile: null,
      scope: "project",
      keyPath: "diagnostics.level",
      rawValue: "warn",
    });

    expect(outcome).toMatchObject({
      kind: "written",
      path: localPath("/workspace/.falryn/falryn.jsonc"),
    });
    expect(fileSystem.paths()).toContain(localPath("/d/legacy-config/falryn.jsonc"));
  });

  test("creates a user file when absent", async () => {
    const { registry, fileSystem } = harness();
    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "debug",
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") {
      throw new Error("expected written");
    }
    const read = await fileSystem.readText(outcome.path, 256 * 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected readable file");
    }
    expect(read.value).toContain('"level": "debug"');
  });

  test("refuses an invalid value before writing", async () => {
    const { registry, fileSystem } = harness();
    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "not-a-level",
    });
    expect(outcome.kind).toBe("rejected");
    expect(fileSystem.paths()).not.toContain(USER_FILE);
  });

  test("refuses a stale revision", async () => {
    const { registry, fileSystem } = harness({
      [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "info" } }`),
    });
    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "warn",
      expectedRevision: "wrong-revision",
    });
    expect(outcome.kind).toBe("stale-write");
  });

  test("updates an existing file while preserving other keys", async () => {
    const { registry, fileSystem } = harness({
      [USER_FILE]: file(
        `{ "schemaVersion": 1, "diagnostics": { "level": "info", "debugWindow": { "ttlMs": 60000 } } }`,
      ),
    });
    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "diagnostics.level",
      rawValue: "warn",
    });
    expect(outcome.kind).toBe("written");
    const read = await fileSystem.readText(localPath(USER_FILE), 256 * 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected readable file");
    }
    expect(read.value).toContain('"level": "warn"');
    expect(read.value).toContain('"ttlMs": 60000');
  });
});

describe("writeConfigurationKey with fixture registry", () => {
  test("refuses map keys that cannot be set from a string", async () => {
    const declaration = enumKey({
      path: "fixture.mode",
      summary: "mode",
      allowed: ["fast", "careful"],
      defaultValue: "fast",
      scopes: ["user"],
      applicationClass: "live",
    });
    const registry = createConfigurationRegistry({
      declarations: [declaration],
      redactor: createRuntimeRedactor(),
    });
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/d/config": { kind: "directory" } },
    });
    const outcome = await writeConfigurationKey(registry, fileSystem, {
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
      scope: "user",
      keyPath: "fixture.map",
      rawValue: "fast",
    });
    expect(outcome.kind).toBe("rejected");
  });
});
