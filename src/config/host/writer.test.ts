import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor } from "../../application/diagnostics/index.ts";
import { err } from "../../domain/foundation/index.ts";
import {
  createInMemoryFileSystem,
  type InMemoryNode,
  localPath,
} from "../../domain/workspace/index.ts";
import { enumKey } from "../document/declaration.ts";
import { V0_1_CONFIGURATION_KEYS, V0_1_CROSS_FIELD_RULES } from "../resolution/keys.ts";
import { createConfigurationRegistry } from "../resolution/registry.ts";
import { CONFIGURATION_FILE_NAME } from "../resolution/sources.ts";
import { writeConfigurationKey } from "./writer.ts";

const CONFIG_ROOT = localPath("/d/config");
const LEGACY_CONFIG_ROOT = localPath("/d/legacy-config");
const USER_FILE = `/d/config/${CONFIGURATION_FILE_NAME}`;
const REQUEST = {
  configurationRoot: CONFIG_ROOT,
  workspaceRoot: null,
  profile: null,
  scope: "user" as const,
  keyPath: "diagnostics.level",
  rawValue: "warn",
};

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
  test("invalid legacy bytes are refused before moving the configuration home", async () => {
    const { registry, fileSystem } = harness({
      "/d/legacy-config": { kind: "directory" },
      "/d/legacy-config/falryn.jsonc": file('{"diagnostics":'),
    });
    expect(
      await writeConfigurationKey(registry, fileSystem, {
        ...REQUEST,
        legacyConfigurationRoot: LEGACY_CONFIG_ROOT,
      }),
    ).toMatchObject({ kind: "filesystem" });
    expect(fileSystem.paths()).toContain(LEGACY_CONFIG_ROOT);
    expect(fileSystem.paths()).not.toContain(USER_FILE);
  });
  test("keeps BOM, comments, newer fields and external scripts byte-for-byte", async () => {
    const source =
      '\uFEFF// notes\r\n{ "schemaVersion": 2, "minimumReaderSchemaVersion": 1, "future": { "untouched": 42 }, "diagnostics": { /* level */ "level": "info", }, }\r\n';
    const script = "# authored environment\nexport EXAMPLE='retained'\n";
    const { registry, fileSystem } = harness({
      [USER_FILE]: file(source),
      "/d/config/env.zsh": file(script),
    });
    const result = await writeConfigurationKey(registry, fileSystem, REQUEST);
    expect(result.kind).toBe("written");
    const saved = await fileSystem.readBytes(localPath(USER_FILE), 256 * 1024);
    expect(saved.ok && new TextDecoder("utf-8", { ignoreBOM: true }).decode(saved.value)).toBe(
      source.replace('"info"', '"warn"'),
    );
    expect(await fileSystem.readText(localPath("/d/config/env.zsh"), 1024)).toEqual({
      ok: true,
      value: script,
    });
  });

  test("reset removes the override, retains its comments and never creates an absent file", async () => {
    const source = '{"schemaVersion":1,"diagnostics":{/* keep */"level":"warn",}}';
    const { registry, fileSystem } = harness({ [USER_FILE]: file(source) });
    expect(
      await writeConfigurationKey(registry, fileSystem, { ...REQUEST, operation: "remove" }),
    ).toMatchObject({ kind: "written", changedPaths: ["diagnostics.level"] });
    expect(await fileSystem.readText(localPath(USER_FILE), 1024)).toEqual({
      ok: true,
      value: '{"schemaVersion":1,"diagnostics":{/* keep */}}',
    });
    const empty = harness();
    expect(
      await writeConfigurationKey(empty.registry, empty.fileSystem, {
        ...REQUEST,
        operation: "remove",
      }),
    ).toMatchObject({ kind: "unchanged", revision: null });
    expect(empty.fileSystem.paths()).not.toContain(USER_FILE);
  });

  test("no-op keeps bytes and revision; cancelled and malformed writes do not mutate", async () => {
    for (const source of [
      '// keep\n{"schemaVersion":1,"diagnostics":{"level":"warn"}}',
      '{"diagnostics":',
      '{"schemaVersion":1,"diagnostics":{"level":"info","level":"debug"}}',
    ]) {
      const { registry, fileSystem } = harness({ [USER_FILE]: file(source) });
      const before = await fileSystem.stat(localPath(USER_FILE));
      const result = await writeConfigurationKey(registry, fileSystem, REQUEST);
      expect(result.kind === "written" ? result.save : result.kind).toBe(
        source.startsWith("//") ? "unchanged" : "filesystem",
      );
      expect(await fileSystem.stat(localPath(USER_FILE))).toEqual(before);
      expect(await fileSystem.readText(localPath(USER_FILE), 1024)).toEqual({
        ok: true,
        value: source,
      });
      expect(
        await writeConfigurationKey(registry, fileSystem, REQUEST, AbortSignal.abort()),
      ).toEqual({ kind: "cancelled" });
    }
  });

  test("refuses missing expected files and a second session changing the file at publication", async () => {
    const { registry, fileSystem } = harness();
    expect(
      await writeConfigurationKey(registry, fileSystem, {
        ...REQUEST,
        expectedRevision: "deleted-file",
      }),
    ).toMatchObject({ kind: "stale-write" });
    const concurrent = '{"schemaVersion":1,"diagnostics":{"level":"debug"}}';
    const wrapped = {
      ...fileSystem,
      writeBytes: async (...args: Parameters<typeof fileSystem.writeBytes>) => {
        fileSystem.put(USER_FILE, { kind: "file", text: concurrent, revision: "other-session" });
        return fileSystem.writeBytes(...args);
      },
    };
    expect(await writeConfigurationKey(registry, wrapped, REQUEST)).toMatchObject({
      kind: "stale-write",
    });
    expect(await fileSystem.readText(localPath(USER_FILE), 1024)).toEqual({
      ok: true,
      value: concurrent,
    });
  });

  test("failed storage retains the original, and invalid composed settings never reach storage", async () => {
    const source = '{"schemaVersion":1,"diagnostics":{"level":"info"}}';
    const { registry, fileSystem } = harness({ [USER_FILE]: file(source) });
    let writes = 0;
    const failing = {
      ...fileSystem,
      writeBytes: async () => {
        writes++;
        return err({
          kind: "filesystem" as const,
          operation: "write" as const,
          path: localPath(USER_FILE),
          code: "io-failure" as const,
        });
      },
    };
    expect(await writeConfigurationKey(registry, failing, REQUEST)).toMatchObject({
      kind: "filesystem",
      code: "io-failure",
    });
    expect(await fileSystem.readText(localPath(USER_FILE), 1024)).toEqual({
      ok: true,
      value: source,
    });
    expect(
      await writeConfigurationKey(registry, failing, {
        ...REQUEST,
        validateCandidate: async () => [
          { kind: "invalid-value", severity: "error", path: "diagnostics.level", allowed: [] },
        ],
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(writes).toBe(1);
  });
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
