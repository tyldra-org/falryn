/**
 * `$` capability mentions through the real MCP composition (#1206): an explicit-only
 * server is listed, a pick connects it as the user's request, and model calls in that
 * turn are the user's selection only when the host passes it.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capabilityMentionPick,
  exactCapabilityMention,
} from "../../domain/context/capability-mentions.ts";
import type { ComposerToken } from "../../domain/context/composer-mentions.ts";
import { boundCatalogFixture, catalogFixture } from "../../domain/extensions/catalog-fixtures.ts";
import { createStaticEnvironment, invocationId } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions.ts";
import type { GlobalOptions } from "../options.ts";
import { composeCapabilityMentions } from "./product-capability-mentions.ts";
import { composeHostProductCredentials } from "./product-credentials.ts";
import { composeProductMcp } from "./product-mcp.ts";
import { createServiceProvider } from "./services.ts";
import { standaloneEnvironment } from "./standalone-environment.ts";

const posix = process.platform === "win32" ? test.skip : test;
/** Starts a real stdio MCP fixture process and discovers its catalog. */
const MCP_PROCESS = 30_000;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("an activated package offers its bound actions; one with nothing activated says why", async () => {
  const bound = catalogFixture("gmail");
  const available = {
    ...bound,
    availability: "available" as const,
    binding: {
      ...(boundCatalogFixture("gmail").binding as NonNullable<typeof bound.binding>),
      actionId: "package:gmail/search@1",
    },
  };
  const idle = { ...catalogFixture("outlook"), trust: "required" as const };
  const mentions = composeCapabilityMentions({
    skills: async () => null,
    packages: () => ({
      version: 1,
      generation: 7,
      identity: "catalog",
      inputs: "inputs",
      entries: [available, idle],
      metadataBytes: 0,
    }),
    mcp: {
      servers: () => [],
      generation: () => 1,
      catalogState: () => "unknown",
      capabilityIds: () => [],
      connect: async () => ({ ok: true }),
    },
  });
  const candidates = await mentions.candidates(new AbortController().signal);
  expect(candidates.map((item) => [item.name, item.availability.kind, item.capabilityIds])).toEqual(
    [
      ["gmail", "available", ["package:gmail/search@1"]],
      ["outlook", "unavailable", []],
    ],
  );
  expect(candidates[1]?.availability).toMatchObject({
    reason: "not trusted",
    repair: "/extensions outlook",
  });
  const admitted = await mentions.admit(
    [await tokenFor(mentions, "gmail")],
    new AbortController().signal,
  );
  expect(admitted).toMatchObject({
    ok: true,
    packages: ["gmail"],
    preferredCapabilityIds: ["package:gmail/search@1"],
  });
});

const fixturePath = fileURLToPath(
  new URL("../../integrations/extensions/mcp-fixtures.ts", import.meta.url),
);

async function explicitOnlyServer() {
  const root = await mkdtemp(join(tmpdir(), "falryn-mentions-mcp-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(config);
  await mkdir(workspace);
  await writeFile(
    join(config, "falryn.jsonc"),
    JSON.stringify({
      schemaVersion: 2,
      minimumReaderSchemaVersion: 2,
      connections: {
        mcp: {
          servers: [
            {
              id: "fixture",
              transport: "stdio",
              executable: process.execPath,
              args: [fixturePath, "environment"],
              explicitOnly: true,
            },
            { id: "off", transport: "stdio", executable: process.execPath, enabled: false },
          ],
        },
      },
    }),
  );
  const globals: GlobalOptions = {
    color: "never",
    format: "json",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace,
    addDirs: [],
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(root),
    currentDirectory: localPath(workspace),
    environment: createStaticEnvironment({
      FALRYN_CONFIG_DIR: config,
      FALRYN_STATE_DIR: join(root, "state"),
    }),
  });
  const graph = services();
  const environment = await standaloneEnvironment(graph, globals);
  cleanups.push(environment.close);
  // Servers start in a prepared scoped environment, as the product prepares it.
  await environment.control.execute("reload");
  const configuration = () => {
    const record = graph.loader.current();
    if (!record) throw new Error("missing configuration");
    return { values: record.values, generation: Number(record.generation), record };
  };
  const mcp = composeProductMcp({
    identity: crypto.randomUUID(),
    generation: configuration().record.generation,
    configuration,
    services: createHostManagedServicePort(),
    context: environment.context,
    credentials: composeHostProductCredentials({
      clock: graph.clock,
      environment: graph.environment,
    }).resolver,
    authorize: async () => true,
  });
  cleanups.push(mcp.close);
  const mentions = composeCapabilityMentions({
    skills: async () => null,
    packages: () => undefined,
    mcp: {
      servers: () => mcp.configuration().servers,
      generation: () => mcp.configuration().generation,
      catalogState: (serverId) =>
        mcp.catalog.summaries().find((summary) => summary.serverId === serverId)?.state ??
        "unknown",
      capabilityIds: () =>
        mcp.tools.registry.entries.map((entry) => String(entry.manifest.capabilityId)),
      async connect(serverId, signal) {
        const call = {
          origin: "user" as const,
          requestId: crypto.randomUUID(),
          deadline: Date.now() + 10_000,
          signal,
        };
        const connected = await mcp.lifecycle.connect({
          ...call,
          serverId,
          configurationGeneration: mcp.configuration().generation,
        });
        if (connected.kind !== "completed") return { ok: false, reason: connected.code };
        const discovered = await mcp.catalog.discover(serverId, call);
        return discovered.kind === "completed"
          ? { ok: true }
          : { ok: false, reason: discovered.code };
      },
    },
  });
  let calls = 0;
  const run = (
    toolName: string,
    input: Record<string, unknown>,
    mcpServers?: readonly string[],
  ) => {
    const entry = mcp.tools.registry.resolveByName(toolName);
    if (!entry) throw new Error(`missing ${toolName}`);
    calls += 1;
    return mcp.tools.runner.execute({
      invocationId: invocationId.from(`mention-${calls}`),
      toolCallId: `mention-${calls}`,
      toolName,
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input,
      signal: new AbortController().signal,
      ...(mcpServers === undefined ? {} : { userSelection: { mcpServers } }),
    });
  };
  return { mcp, mentions, run };
}

async function tokenFor(
  mentions: ReturnType<typeof composeCapabilityMentions>,
  query: string,
): Promise<ComposerToken> {
  const row = exactCapabilityMention(
    query,
    await mentions.candidates(new AbortController().signal),
  );
  if (row === null) throw new Error(`no exact row for ${query}`);
  const pick = capabilityMentionPick(row);
  return { ...pick, id: "t1", start: 0, end: pick.label.length };
}

posix(
  "a picked explicit-only server connects as the user's request and its calls count as the user's in that turn",
  async () => {
    const { mcp, mentions, run } = await explicitOnlyServer();
    const rows = (await mentions.source.query("mcp:", new AbortController().signal)).rows;
    expect(rows.map((row) => [row.label, row.unavailable?.reason ?? null])).toEqual([
      ["$mcp:fixture", null],
      ["$mcp:off", "disabled in configuration"],
    ]);
    expect(rows[0]?.detail).toContain("explicit only");
    const generation = mcp.configuration().generation;
    // The model alone cannot start an explicit-only server.
    const refused = await run("mcp_connect", {
      serverId: "fixture",
      configurationGeneration: generation,
    });
    expect(refused.status).not.toBe("completed");

    const admitted = await mentions.admit(
      [await tokenFor(mentions, "mcp:fixture")],
      new AbortController().signal,
    );
    expect(admitted).toMatchObject({ ok: true, mcpServers: ["fixture"], connect: [] });
    if (!admitted.ok) return;
    expect(admitted.preferredCapabilityIds.length).toBeGreaterThan(0);
    expect(mcp.catalog.summaries().find((item) => item.serverId === "fixture")?.state).toBe(
      "current",
    );
    // In the turn that carries the selection, the model's call is the user's.
    const selected = await run(
      "mcp_connect",
      { serverId: "fixture", configurationGeneration: generation },
      ["fixture"],
    );
    expect(selected.status).toBe("completed");
    // Another turn without it is refused again.
    expect(
      (await run("mcp_connect", { serverId: "fixture", configurationGeneration: generation }))
        .status,
    ).not.toBe("completed");
  },
  MCP_PROCESS,
);

posix("a disabled server is refused by name and nothing connects", async () => {
  const { mcp, mentions } = await explicitOnlyServer();
  const off = (await mentions.candidates(new AbortController().signal)).find(
    (candidate) => candidate.name === "off",
  );
  if (off === undefined) throw new Error("missing off");
  const token: ComposerToken = {
    id: "t9",
    trigger: "$",
    kind: "mcp-server",
    identity: off.identity,
    label: "$mcp:off",
    source: off.source,
    generation: off.generation,
    start: 0,
    end: 8,
  };
  const admitted = await mentions.admit([token], new AbortController().signal);
  expect(admitted).toMatchObject({
    ok: false,
    failures: [{ tokenId: "t9", code: "mention.unavailable" }],
  });
  expect(mcp.lifecycle.inspect().every((snapshot) => snapshot.state !== "available")).toBe(true);
});
