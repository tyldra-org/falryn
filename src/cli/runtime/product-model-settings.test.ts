import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import { parseInvocation } from "../command-tree.ts";
import { runConfigSet } from "../commands/config.ts";
import { runModel } from "../commands/model.ts";
import type { GlobalOptions } from "../options.ts";
import { composeProductModelSettings } from "./product-model-settings.ts";
import { createServiceProvider } from "./services.ts";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: true,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};

test("working profile saves and resets stay local across restart, including membership and processing", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-working-models-"));
  try {
    const globals = { ...GLOBALS, profile: "child" };
    const factory = () =>
      createServiceProvider(globals, {
        home: localPath(home),
        platform: "darwin",
        currentDirectory: localPath(home),
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
      });
    const services = factory();
    const root = services().configurationRoot;
    await mkdir(join(root, "profiles"), { recursive: true });
    const route = { providerProfileId: "openai", providerId: "openai", modelId: "inherited" };
    await writeFile(
      join(root, "profiles", "parent.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        minimumReaderSchemaVersion: 2,
        overrides: {
          models: {
            policy: {
              processing: { mode: "fast", fallback: "allow-standard" },
              roles: {
                plan: route,
                subagents: { agents: { "user:helper": { preset: "small", route } } },
              },
            },
          },
        },
      }),
    );
    const path = join(root, "profiles", "child.jsonc");
    await writeFile(
      path,
      '{"schemaVersion":2,"minimumReaderSchemaVersion":2,"extends":"parent",/* keep */"overrides":{}}',
    );
    const service = () => composeProductModelSettings(factory()(), globals);
    async function edit(change: object) {
      const current = service();
      const inspection = await current.execute({ kind: "inspect" });
      if (inspection.kind !== "inspection") throw new Error(JSON.stringify(inspection));
      const result = await current.execute({
        kind: "edit",
        edit: change,
        expectedRevision: inspection.fileRevision,
      });
      expect(result.kind).toBe("written");
      expect(result.kind === "written" && result.receipt?.publication).toBe("published");
    }
    await edit({ kind: "membership", id: "user:helper", preset: "big" });
    await edit({ kind: "processing-default", processing: { mode: "standard" } });
    let inspection = await service().execute({ kind: "inspect" });
    if (inspection.kind !== "inspection") throw new Error(JSON.stringify(inspection));
    expect(inspection.preferences.roles.subagents?.agents?.["user:helper"]).toMatchObject({
      preset: "big",
      route: { modelId: "inherited" },
    });
    expect(inspection.preferences.processing).toEqual({
      mode: "standard",
      fallback: "allow-standard",
    });
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("/* keep */");
    expect(saved).not.toContain("inherited");
    expect(saved).not.toContain("allow-standard");
    await edit({ kind: "membership", id: "user:helper", preset: null });
    await edit({ kind: "reset", target: { kind: "agent", id: "user:helper" } });
    await edit({ kind: "processing-default" });
    inspection = await service().execute({ kind: "inspect" });
    if (inspection.kind !== "inspection") throw new Error(JSON.stringify(inspection));
    expect(inspection.preferences.roles.subagents?.agents?.["user:helper"]).toMatchObject({
      preset: "small",
      route: { modelId: "inherited" },
    });
    expect(String(inspection.preferences.roles.plan?.modelId)).toBe("inherited");
    expect(inspection.preferences.processing?.mode).toBe("fast");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("CLI and restarted product settings share atomic configuration, migration recovery and stale revision detection", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-model-settings-"));
  try {
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });
    const service = composeProductModelSettings(services(), GLOBALS);
    const settings = join(services().configurationRoot, "falryn.jsonc");
    await mkdir(services().configurationRoot, { recursive: true });
    await writeFile(
      settings,
      '// authored 🌱\r\n{\r\n\t"schemaVersion": 1,\r\n\t"diagnostics": { /* keep this */ "level": "info", }, // retained\r\n}\r\n',
    );
    const config = await runConfigSet(
      services,
      { keyPath: "diagnostics.level", rawValue: "debug", scope: "user", expectedRevision: null },
      GLOBALS,
    );
    expect(config.payload?.save).toBe("saved");
    const inspection = await service.execute({ kind: "inspect" });
    if (inspection.kind !== "inspection") throw new Error(JSON.stringify(inspection));
    const main = inspection.rows[0]?.selection;
    if (main?.kind !== "route") throw new Error("Expected the configured main model");
    const input = join(home, "edit.json");
    await writeFile(
      input,
      JSON.stringify({
        kind: "edit",
        edit: { kind: "configure", target: { kind: "role", role: "fast" }, route: main.route },
        expectedRevision: inspection.fileRevision,
      }),
    );
    const invocation = await parseInvocation(["model", "configure", "--input", input]);
    if (invocation.kind !== "run" || invocation.modelArgs === undefined)
      throw new Error("Expected model command");
    const result = await runModel(services, invocation.modelArgs, GLOBALS);
    expect(result.payload?.kind).toBe("written");
    const authored = await readFile(settings, "utf8");
    expect(authored).toContain("// authored 🌱\r\n");
    expect(authored).toContain(
      '"diagnostics": { /* keep this */ "level": "debug", }, // retained\r\n',
    );
    expect(result.payload?.kind === "written" && result.payload.receipt?.publication).toBe(
      "published",
    );
    const restarted = composeProductModelSettings(services(), GLOBALS);
    const after = await restarted.execute({ kind: "inspect" });
    if (after.kind !== "inspection") throw new Error("Expected inspection after restart");
    expect(after.preferences.roles.fast?.default).toEqual(main.route);
    expect(after.preferences.roles.fast?.use).toBeUndefined();
    expect((await runModel(services, invocation.modelArgs, GLOBALS)).payload).toEqual({
      kind: "failed",
      code: "stale-settings",
    });
    const original = {
      roles: {
        default: main.route,
        compact: { ...roleRouteBaseSchema.parse(main.route), use: "off" },
      },
    };
    const preview = await restarted.execute({ kind: "preview-migration", original });
    if (preview.kind !== "preview") throw new Error("Expected migration preview");
    const applied = await restarted.execute({
      kind: "apply-migration",
      original,
      candidate: preview.candidate,
      decisions: {},
      expectedRevision: after.fileRevision,
    });
    if (applied.kind !== "written" || applied.backup === null)
      throw new Error(JSON.stringify(applied));
    const recovery = JSON.parse(await readFile(applied.backup, "utf8"));
    expect(recovery.original.original).toEqual(original);
    const latest = await restarted.execute({ kind: "inspect" });
    expect(
      latest.kind === "inspection" && latest.preferences.roles.fast?.use?.memory,
    ).toBeUndefined();
    expect(recovery.source.text).toBe(authored);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each(["current", "legacy"] as const)(
  "explicit migration backs up exact %s source bytes and survives restart",
  async (location) => {
    const home = await mkdtemp(join(tmpdir(), "falryn-policy-v2-"));
    try {
      const services = createServiceProvider(GLOBALS, {
        home: localPath(home),
        platform: "darwin",
        currentDirectory: localPath(home),
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: join(home, "state") }),
      });
      const graph = services();
      const root = location === "legacy" ? graph.legacyConfigurationRoot : graph.configurationRoot;
      if (root === null) throw new Error("Missing legacy fixture root");
      await mkdir(root, { recursive: true });
      const route = (modelId: string) =>
        roleRouteBaseSchema.parse({ providerProfileId: "fixture", providerId: "test", modelId });
      const policy = {
        ...EMPTY_MODEL_PREFERENCES,
        schemaVersion: 2,
        revision: 4,
        intents: { ...EMPTY_MODEL_PREFERENCES.intents, compression: "fast" },
        roles: {
          default: route("main"),
          fast: {
            default: route("cheap"),
            options: { memory: route("memory"), compaction: route("retired") },
            use: { memory: "off", compaction: "evaluated" },
          },
        },
      };
      const source = `\uFEFF// authored 🌱\r\n{\r\n "schemaVersion": 1,\r\n "diagnostics": { /* keep */ "level": "info", },\r\n "models": { "policy": ${JSON.stringify(policy)} },\r\n}\r\n`;
      const settings = join(root, "falryn.jsonc");
      await writeFile(settings, source);
      const service = composeProductModelSettings(graph, GLOBALS);
      const inspected = await service.execute({ kind: "inspect" });
      expect(inspected.kind).toBe("inspection");
      if (inspected.kind !== "inspection") throw new Error(JSON.stringify(inspected));
      expect(inspected.migrationRequired).toBe(true);
      expect(inspected.preferences.roles.default).toEqual(policy.roles.default);
      expect(
        inspected.rows.some(
          (row) => row.target.kind === "fast" && String(row.target.option) === "compaction",
        ),
      ).toBe(false);
      expect(
        await service.execute({
          kind: "edit",
          edit: { kind: "use", option: "memory", use: "evaluated" },
          expectedRevision: inspected.fileRevision,
        }),
      ).toEqual({ kind: "failed", code: "model-policy-migration-required" });
      const preview = await service.execute({ kind: "preview-migration" });
      if (preview.kind !== "preview") throw new Error(JSON.stringify(preview));
      expect(preview.unresolved).toEqual([]);
      expect(await readFile(settings, "utf8")).toBe(source);
      const apply = {
        kind: "apply-migration",
        original: preview.original,
        decisions: preview.decisions,
        candidate: preview.candidate,
        expectedRevision: preview.expectedRevision,
      };
      expect(await service.execute(apply, AbortSignal.abort())).toEqual({
        kind: "failed",
        code: "cancelled",
      });
      const write = graph.fileSystem.writeBytes;
      graph.fileSystem.writeBytes = async (path, bytes, signal) =>
        String(path).includes("model-policy-backups")
          ? {
              ok: false,
              error: {
                kind: "filesystem",
                operation: "write",
                code: "permission-denied",
                path,
              },
            }
          : write(path, bytes, signal);
      expect(await service.execute(apply)).toEqual({ kind: "failed", code: "backup-write-failed" });
      expect(await readFile(settings, "utf8")).toBe(source);
      graph.fileSystem.writeBytes = write;
      const applied = await service.execute(apply);
      if (applied.kind !== "written" || applied.backup === null)
        throw new Error(JSON.stringify(applied));
      const backup = JSON.parse(await readFile(applied.backup, "utf8"));
      expect(backup.source).toEqual({ path: settings, text: source });
      expect(Buffer.from(backup.source.text)).toEqual(Buffer.from(source));
      const saved = await readFile(join(graph.configurationRoot, "falryn.jsonc"), "utf8");
      expect(saved).toContain("\uFEFF// authored 🌱\r\n");
      expect(saved).toContain('"diagnostics": { /* keep */ "level": "info", },');
      expect(saved).not.toContain('"compaction"');
      const after = await composeProductModelSettings(
        createServiceProvider(GLOBALS, {
          home: localPath(home),
          platform: "darwin",
          currentDirectory: localPath(home),
          environment: createStaticEnvironment({ FALRYN_STATE_DIR: join(home, "state") }),
        })(),
        GLOBALS,
      ).execute({ kind: "inspect" });
      expect(after.kind === "inspection" && after.migrationRequired).toBe(false);
      expect(after.kind === "inspection" && after.preferences.roles.default).toEqual(
        policy.roles.default,
      );
      expect(after.kind === "inspection" && after.preferences.roles.fast?.options?.memory).toEqual(
        policy.roles.fast.options.memory,
      );
      expect(after.kind === "inspection" && after.preferences.roles.fast?.use).toEqual({
        memory: "off",
      });
      expect(await service.execute(apply)).toEqual({ kind: "failed", code: "stale-settings" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("a saved model policy keeps its receipt when the subsequent reload fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-settings-reload-"));
  try {
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });
    const graph = services();
    const service = composeProductModelSettings(graph, GLOBALS);
    const before = await service.execute({ kind: "inspect" });
    if (before.kind !== "inspection") throw new Error("expected inspection");
    const load = graph.loader.load;
    const write = graph.fileSystem.writeBytes;
    let saved = false;
    graph.fileSystem.writeBytes = async (...args) => {
      const result = await write(...args);
      saved = result.ok;
      return result;
    };
    graph.loader.load = async (...args) =>
      saved
        ? {
            kind: "publish-failed",
            code: "fixture-event-store-unavailable",
            retained: graph.loader.current(),
          }
        : load(...args);
    const result = await service.execute({
      kind: "edit",
      edit: { kind: "use", option: "memory", use: "off" },
      expectedRevision: before.fileRevision,
    });
    expect(result).toMatchObject({
      kind: "written",
      receipt: { save: "saved", publication: "failed", application: "failed" },
    });
    expect(await readFile(join(graph.configurationRoot, "falryn.jsonc"), "utf8")).toContain(
      '"memory": "off"',
    );
    saved = false;
    const restarted = await composeProductModelSettings(graph, GLOBALS).execute({
      kind: "inspect",
    });
    expect(restarted.kind === "inspection" && restarted.preferences.roles.fast?.use?.memory).toBe(
      "off",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
