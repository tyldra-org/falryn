import { describe, expect, test } from "bun:test";
import { createRuntimeRedactor } from "../../application/diagnostics/index.ts";
import { PRODUCT_CONFIGURATION_KEYS } from "../../cli/runtime/services.ts";
import {
  createManualClock,
  createStaticEnvironment,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { applyConfigurationMigration, previewConfigurationMigration } from "../host/migration.ts";
import { writeConfigurationKey } from "../host/writer.ts";
import { createConfigurationLoader } from "./loader.ts";
import { createConfigurationRegistry } from "./registry.ts";

const request = {
  configurationRoot: localPath("/home/config"),
  workspaceRoot: localPath("/work"),
  profile: null,
};
const v2 = (fields: object) => ({ schemaVersion: 2, minimumReaderSchemaVersion: 2, ...fields });
function fixture() {
  const fs = createInMemoryFileSystem();
  const registry = createConfigurationRegistry({
    declarations: PRODUCT_CONFIGURATION_KEYS,
    redactor: createRuntimeRedactor(),
  });
  const loader = createConfigurationLoader({
    registry,
    declarations: PRODUCT_CONFIGURATION_KEYS,
    fileSystem: fs,
    redactor: createRuntimeRedactor(),
    environment: createStaticEnvironment({}),
    clock: createManualClock(),
    eventStore: createInMemoryEventStore(),
    streamId: streamId.from("config"),
    correlation: {
      workspaceId: workspaceId.from("w"),
      sessionId: sessionId.from("s"),
      traceId: traceId.from("t"),
    },
  });
  const put = (path: string, value: object | string) =>
    fs.put(path, { kind: "file", text: typeof value === "string" ? value : JSON.stringify(value) });
  const profile = (id: string, value: object) =>
    put(`/home/config/profiles/${id}.jsonc`, v2(value));
  const load = async (selection: string | null = null) =>
    loader.load({ ...request, profile: selection });
  return { fs, registry, loader, put, profile, load };
}
async function values(f: ReturnType<typeof fixture>, id: string | null = null) {
  const result = await f.load(id);
  if (result.kind !== "published") throw new Error(JSON.stringify(result));
  expect(result.kind).toBe("published");
  return result.record;
}

describe("organized working configuration", () => {
  test("empty install is virtual and creates no file", async () => {
    const f = fixture();
    const record = await values(f);
    expect(record.workingProfile).toEqual({
      id: "default",
      selectedBy: "built-in",
      virtual: true,
      ancestry: [],
    });
    expect(await f.fs.stat(request.configurationRoot)).toEqual({ ok: true, value: null });
  });
  test("global default, explicit selection, workspace association and real default are distinct", async () => {
    const f = fixture();
    f.put("/home/config/falryn.jsonc", v2({ profiles: { default: "global" } }));
    for (const id of ["global", "explicit", "personal", "default"])
      f.profile(id, {
        overrides: { privacy: { diagnostics: { level: id === "global" ? "warn" : "debug" } } },
      });
    expect((await values(f)).workingProfile?.id).toBe("global");
    expect((await values(f, "explicit")).workingProfile?.selectedBy).toBe("explicit");
    const personal = await f.loader.load({ ...request, workspaceProfile: "personal" });
    expect(personal.kind === "published" && personal.record.workingProfile?.selectedBy).toBe(
      "workspace",
    );
    expect((await values(f, "default")).workingProfile?.virtual).toBe(false);
  });
  test("ancestry preserves false and distinct roles; changed model clears inherited thinking", async () => {
    const f = fixture();
    const route = {
      providerProfileId: "openai",
      providerId: "openai",
      modelId: "old",
      reasoning: "deep",
    };
    f.put(
      "/home/config/falryn.jsonc",
      v2({ defaults: { models: { policy: { roles: { default: route, plan: route } } } } }),
    );
    f.profile("parent", {
      overrides: {
        interface: { pointer: { enabled: false } },
        models: { policy: { roles: { vision: { ...route, modelId: "vision" } } } },
      },
    });
    f.profile("child", {
      extends: "parent",
      overrides: { models: { policy: { roles: { default: { modelId: "new" } } } } },
    });
    const record = await values(f, "child");
    expect(record.values["interface.pointer.enabled"]).toBe(false);
    expect(record.values["models.policy"]).toMatchObject({
      roles: {
        default: { modelId: "new", reasoning: "provider-default" },
        plan: { modelId: "old", reasoning: "deep" },
        vision: { modelId: "vision" },
      },
    });
    expect(record.workingProfile?.ancestry.map((entry) => entry.id)).toEqual(["parent", "child"]);
    expect(record.workingProfile?.ancestry.every((entry) => entry.revision !== null)).toBe(true);
  });
  test("version-one model policy continues to replace the whole value", async () => {
    const f = fixture();
    const route = { providerProfileId: "openai", providerId: "openai", modelId: "old" };
    f.put("/home/config/falryn.jsonc", {
      schemaVersion: 1,
      models: { policy: { schemaVersion: 3, revision: 0, roles: { plan: route } } },
    });
    f.put("/home/config/profiles/legacy.jsonc", {
      schemaVersion: 1,
      models: { policy: { schemaVersion: 3, revision: 0, roles: { default: route } } },
    });
    expect((await values(f, "legacy")).values["models.policy"]).toMatchObject({
      roles: { default: { modelId: "old" } },
    });
    expect(
      (f.loader.current()?.values["models.policy"] as { roles: object } | undefined)?.roles,
    ).not.toHaveProperty("plan");
  });
  test.each(["missing", "../escape", "", "wrong"])(
    "explicit unavailable selection refuses: %s",
    async (id) => {
      const f = fixture();
      f.profile("Wrong", {});
      expect((await f.load(id)).kind).toBe("rejected");
    },
  );
  test("missing parents, cycles, and case ambiguity refuse; eight profiles pass", async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) f.profile(`p${i}`, i === 0 ? {} : { extends: `p${i - 1}` });
    expect((await values(f, "p7")).workingProfile?.ancestry).toHaveLength(8);
    f.profile("p8", { extends: "p7" });
    expect((await f.load("p8")).kind).toBe("rejected");
    f.profile("p0", { extends: "p7" });
    expect((await f.load("p7")).kind).toBe("rejected");
    f.profile("p0", { extends: "missing" });
    expect((await f.load("p0")).kind).toBe("rejected");
    f.profile("P1", {});
    expect((await f.load("p1")).kind).toBe("rejected");
  });
  test("private project retains project scope and precedence", async () => {
    const f = fixture();
    f.put(
      "/work/.falryn/falryn.jsonc",
      v2({ defaults: { privacy: { diagnostics: { level: "warn" } } } }),
    );
    f.put(
      "/work/.falryn/local/falryn.local.jsonc",
      v2({ defaults: { privacy: { diagnostics: { level: "debug" } } } }),
    );
    expect((await values(f)).values["diagnostics.level"]).toBe("debug");
    f.put("/work/.falryn/local/falryn.local.jsonc", v2({ connections: { providers: {} } }));
    expect((await f.load()).kind).toBe("rejected");
  });
  test.each([
    { profiles: { default: 2 } },
    { defaults: { data: { roots: { state: "/tmp/forbidden" } } } },
    { defaults: { interface: { pointer: { enabled: null } } } },
    { defaults: { interface: { pointer: { enabled: 0 } } } },
  ])("invalid metadata, roots or values fail without quoting content", async (fields) => {
    const f = fixture();
    f.put("/home/config/falryn.jsonc", v2(fields));
    expect((await f.load()).kind).toBe("rejected");
  });
  test("unknown package configuration is retained inert and reported unavailable", async () => {
    const f = fixture();
    f.profile("pkg", {
      overrides: { capabilities: { packages: { [`p${"a".repeat(32)}`]: { enabled: true } } } },
    });
    const record = await values(f, "pkg");
    expect(record.issues[0]?.kind).toBe("package-unavailable");
    expect(Object.keys(record.values).some((key) => key.startsWith("packages."))).toBe(false);
  });
  test("newer organized fields stay inert; explicit zero and empty maps retain declared meaning", async () => {
    const f = fixture();
    f.put("/home/config/falryn.jsonc", {
      schemaVersion: 4,
      minimumReaderSchemaVersion: 2,
      defaults: {
        future: { token: "sk-secret-test" },
        models: { policy: { revision: 0, roles: {} } },
      },
    });
    const record = await values(f);
    expect(record.values["models.policy"]).toMatchObject({ revision: 0, roles: {} });
    expect(record.issues).toContainEqual({
      kind: "ignored-forward-key",
      severity: "warning",
      path: "defaults.future",
      observedSchemaVersion: 4,
      readerSchemaVersion: 2,
    });
    expect(JSON.stringify(record)).not.toContain("sk-secret-test");
    expect(Object.isFrozen(record.values["models.policy"])).toBe(true);
  });
  test("a working profile cannot replace account definitions, and a lost personal association refuses", async () => {
    const f = fixture();
    f.profile("account-swap", {
      connections: { providers: { selectedProfileId: "another-account" } },
    });
    expect((await f.load("account-swap")).kind).toBe("rejected");
    expect((await f.loader.load({ ...request, workspaceProfile: "removed" })).kind).toBe(
      "rejected",
    );
  });
  test("explicit private-project save creates only a project-scoped source", async () => {
    const f = fixture();
    expect(
      (
        await writeConfigurationKey(f.registry, f.fs, {
          ...request,
          scope: "private-project",
          keyPath: "diagnostics.level",
          rawValue: "debug",
        })
      ).kind,
    ).toBe("written");
    expect((await values(f)).values["diagnostics.level"]).toBe("debug");
    expect(
      (
        await writeConfigurationKey(f.registry, f.fs, {
          ...request,
          scope: "private-project",
          keyPath: "interface.pointer.enabled",
          rawValue: "false",
        })
      ).kind,
    ).toBe("rejected");
  });
  test("malformed secret values stay outside diagnostics", async () => {
    const f = fixture();
    f.put(
      "/home/config/falryn.jsonc",
      '{"schemaVersion":2,"defaults":{"token":"sk-live-ABCDEFGH12345678"',
    );
    const result = await f.load();
    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("ABCDEFGH");
  });
  test("writer edits organized overrides and reset reveals parent without rewriting comments", async () => {
    const f = fixture();
    f.profile("parent", { overrides: { interface: { pointer: { enabled: false } } } });
    f.put(
      "/home/config/profiles/child.jsonc",
      '{"schemaVersion":2,"minimumReaderSchemaVersion":2,"extends":"parent", /* keep */ "overrides":{}}',
    );
    f.fs.put("/home/config/profiles", { kind: "directory" });
    const write = {
      ...request,
      profile: "child",
      scope: "profile" as const,
      keyPath: "interface.pointer.enabled",
      rawValue: "true",
    };
    expect((await writeConfigurationKey(f.registry, f.fs, write)).kind).toBe("written");
    expect((await values(f, "child")).values["interface.pointer.enabled"]).toBe(true);
    expect(
      (await writeConfigurationKey(f.registry, f.fs, { ...write, operation: "remove" })).kind,
    ).toBe("written");
    expect((await values(f, "child")).values["interface.pointer.enabled"]).toBe(false);
    expect(
      await f.fs.readText(localPath("/home/config/profiles/child.jsonc"), 10000),
    ).toMatchObject({ value: expect.stringContaining("/* keep */") });
  });
  test("migration preview is inert, stale apply refuses, explicit apply retains exact recovery bytes", async () => {
    const f = fixture();
    const source =
      '{"schemaVersion":1, "interface":{"pointer":{/* inner */ "enabled":false}}, "diagnostics":{"level":"warn"}}\n';
    f.put("/home/config/falryn.jsonc", source);
    f.fs.put("/home/config", { kind: "directory" });
    const migration = { ...request, scope: "user" as const };
    const preview = await previewConfigurationMigration(f.registry, f.fs, migration);
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.collisions).toEqual([]);
    expect(await f.fs.stat(preview.recovery)).toMatchObject({ value: null });
    expect(
      await applyConfigurationMigration(f.registry, f.fs, migration, {
        id: preview.id,
        revision: "stale",
      }),
    ).toMatchObject({ kind: "refused", code: "stale-migration-preview" });
    const applied = await applyConfigurationMigration(f.registry, f.fs, migration, {
      id: preview.id,
      revision: preview.sourceRevision,
    });
    expect(applied).toMatchObject({ kind: "applied", saved: { kind: "written" } });
    expect(await f.fs.readText(preview.recovery, 10000)).toMatchObject({ value: source });
    expect(await f.fs.readText(preview.path, 10000)).toMatchObject({
      value: expect.stringContaining("/* inner */"),
    });
    expect((await values(f)).values["interface.pointer.enabled"]).toBe(false);
  });
});
