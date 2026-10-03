import { expect, test } from "bun:test";
import { type McpConnection, mcpConnectionSchema } from "../../domain/extensions/mcp.ts";
import {
  type McpCatalogEntry,
  normalizeMcpToolSchema,
} from "../../domain/extensions/mcp-catalog.ts";
import { MCP_PREPARATION_LIMITS } from "../../domain/extensions/mcp-preparation-receipt.ts";
import {
  type CapabilityId,
  configurationGeneration,
  invocationId,
} from "../../domain/foundation/index.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { composeMcpCatalogTools, mcpCatalogToolName } from "./product-mcp-catalog-tools.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { mergeProductToolBundles } from "./product-tools-merge.ts";

const generation = configurationGeneration.from(3);
type ToolEntry = Extract<McpCatalogEntry, { readonly kind: "tool" }>;

function tool(
  serverId: string,
  name: string,
  schema: unknown = {
    type: "object",
    properties: { value: { type: "string" } },
  },
): ToolEntry {
  const normalized = normalizeMcpToolSchema(schema);
  return {
    id: `mcp:${serverId}/tool/${encodeURIComponent(name)}`,
    serverId,
    name,
    title: null,
    description: `Does ${name} work.`,
    descriptionTruncated: false,
    kind: "tool",
    inputSchema: normalized?.schema ?? null,
    schemaDigest: normalized?.digest ?? null,
    annotations: null,
  };
}
const server = (id: string, extra: Record<string, unknown> = {}): McpConnection =>
  mcpConnectionSchema.parse({ id, transport: "stdio", executable: "node", ...extra });

function publish(
  current: readonly { serverId: string; catalogGeneration: number; entry: ToolEntry }[],
  servers: readonly McpConnection[],
  selectedServers: readonly string[] = [],
) {
  const calls: { name: string; selection: unknown; input: unknown }[] = [];
  const published = composeMcpCatalogTools({
    generation,
    catalog: { currentTools: () => current },
    servers,
    selectedServers,
    owner: {
      async callCatalogTool(request, selection) {
        calls.push({ name: request.toolName, selection, input: request.input });
        return { status: "completed", output: { result: { ok: true } }, effect: "completed" };
      },
    },
  });
  return { ...published, calls };
}

test("published names are provider-safe, bounded and stable for an unchanged entry", () => {
  const entry = tool("Fixture.Server", "Echo Value!");
  const name = mcpCatalogToolName(entry.serverId, entry.name, entry.id, entry.schemaDigest ?? "");
  expect(name).toMatch(/^mcp_[a-z0-9-]+_[a-z0-9-]+_[a-z0-9]{8}$/u);
  expect(name.length).toBeLessThanOrEqual(64);
  // Same entry and schema in a later catalog generation keeps the name.
  const first = publish(
    [{ serverId: "fixture", catalogGeneration: 1, entry: tool("fixture", "echo") }],
    [server("fixture")],
  );
  const later = publish(
    [{ serverId: "fixture", catalogGeneration: 9, entry: tool("fixture", "echo") }],
    [server("fixture")],
  );
  expect(first.bundle.toolNames).toEqual(later.bundle.toolNames);
  const changed = publish(
    [
      {
        serverId: "fixture",
        catalogGeneration: 9,
        entry: tool("fixture", "echo", {
          type: "object",
          properties: { other: { type: "number" } },
        }),
      },
    ],
    [server("fixture")],
  );
  expect(changed.bundle.toolNames).not.toEqual(first.bundle.toolNames);
});

test("publication is bounded, withholds unselected explicit-only servers and skips unsupported schemas", () => {
  const many = Array.from({ length: MCP_PREPARATION_LIMITS.publishedTools + 5 }, (_, index) => ({
    serverId: "bulk",
    catalogGeneration: 1,
    entry: tool("bulk", `tool${index}`),
  }));
  const unsupported = {
    serverId: "bulk",
    catalogGeneration: 1,
    entry: { ...tool("bulk", "odd"), inputSchema: null, schemaDigest: null },
  };
  const privateTool = {
    serverId: "private",
    catalogGeneration: 2,
    entry: tool("private", "secret"),
  };
  const disabled = { serverId: "off", catalogGeneration: 4, entry: tool("off", "never") };
  const servers = [
    server("bulk"),
    server("private", { explicitOnly: true }),
    server("off", { enabled: false }),
  ];
  const result = publish([privateTool, ...many, unsupported, disabled], servers);
  expect(result.counts).toEqual({ published: 64, overflow: 5, unsupported: 1, withheld: 1 });
  expect(result.bundle.toolNames.some((name) => name.includes("secret"))).toBe(false);
  expect(result.bundle.toolNames.some((name) => name.includes("never"))).toBe(false);
  // Selecting the explicit-only server publishes its tool first.
  const selected = publish([...many, privateTool], servers, ["private"]);
  expect(selected.bundle.toolNames[0]).toContain("_secret_");
  expect(selected.counts.withheld).toBe(0);
});

test("a published tool forwards its exact entry, generation and schema digest to the MCP owner", async () => {
  const entry = tool("fixture", "echo");
  const result = publish(
    [{ serverId: "fixture", catalogGeneration: 7, entry }],
    [server("fixture")],
  );
  const registered = result.bundle.registry.entries[0];
  if (!registered) throw new Error("missing tool");
  expect(registered.manifest).toMatchObject({
    source: "mcp",
    effect: "external",
    namespace: "mcp",
  });
  const request = {
    toolName: registered.manifest.name,
    capabilityId: registered.manifest.capabilityId,
    version: 1,
    input: { value: "hi" },
    invocationId: invocationId.from("call-1"),
    signal: new AbortController().signal,
  } as unknown as ToolRunnerRequest;
  expect(await result.bundle.runner.execute(request)).toMatchObject({ status: "completed" });
  expect(result.calls).toEqual([
    {
      name: registered.manifest.name,
      selection: { entryId: entry.id, catalogGeneration: 7, schemaDigest: entry.schemaDigest },
      input: { value: "hi" },
    },
  ]);
  expect(
    await result.bundle.runner.execute({ ...request, version: 2 } as ToolRunnerRequest),
  ).toMatchObject({ status: "unavailable", reason: "mcp-binding-mismatch" });
  expect(result.calls).toHaveLength(1);
});

test("user-configured MCP tools are executable without package trust and enter planning as mcp-tool", () => {
  const result = publish(
    [{ serverId: "fixture", catalogGeneration: 1, entry: tool("fixture", "echo") }],
    [server("fixture")],
  );
  const merged = mergeProductToolBundles(generation, [result.bundle]);
  const entry = merged.capabilityRegistry.entries[0];
  expect(entry?.kind).toBe("mcp-tool");
  const id = merged.registry.entries[0]?.manifest.capabilityId;
  if (id === undefined) throw new Error("missing tool");
  expect(merged.runner.hasBinding?.(id)).toBe(true);
  const disclosure = discloseProductTools(merged.capabilityRegistry, merged.registry, {
    task: "echo a value through the fixture",
    mcpPreparation: { schemaVersion: 1, servers: [], tools: result.counts },
  });
  expect(disclosure.receipt.disclosed.map((item) => item.name)).toEqual([
    ...result.bundle.toolNames,
  ]);
  expect(disclosure.receipt.mcpPreparation?.disclosure).toMatchObject({ eager: 1, deferred: 0 });
  expect(disclosure.receipt.mcpPreparation?.disclosure?.eagerSchemaBytes).toBeGreaterThan(0);
  // Without user authorization the same source requires ecosystem trust and cannot run.
  const untrusted = mergeProductToolBundles(generation, [
    { ...result.bundle, userAuthorized: new Set<CapabilityId>() },
  ]);
  const blocked = discloseProductTools(untrusted.capabilityRegistry, untrusted.registry, {
    task: "echo a value through the fixture",
  });
  expect(blocked.receipt.disclosed).toHaveLength(0);
});

test("a full catalog stays out of context: irrelevant tools are deferred or summarized in one omission", () => {
  const current = Array.from({ length: MCP_PREPARATION_LIMITS.publishedTools }, (_, index) => ({
    serverId: "bulk",
    catalogGeneration: 1,
    entry: tool("bulk", `operation${index}`),
  }));
  const result = publish(current, [server("bulk")]);
  const merged = mergeProductToolBundles(generation, [result.bundle]);
  const disclosure = discloseProductTools(merged.capabilityRegistry, merged.registry, {
    task: "summarize the readme",
    mcpPreparation: { schemaVersion: 1, servers: [], tools: result.counts },
  });
  const counts = disclosure.receipt.mcpPreparation?.disclosure;
  expect(counts?.eager).toBe(0);
  // Deferred definitions travel only to transports with native tool search.
  expect(disclosure.modelTools.every((definition) => definition.deferred === true)).toBe(true);
  expect(counts?.deferred).toBe(disclosure.receipt.deferred.length);
  const mcpOmissions = disclosure.receipt.omitted.filter((item) => item.name.startsWith("mcp"));
  expect(mcpOmissions).toEqual([
    {
      name: "mcp-catalog",
      reason: `${64 - disclosure.receipt.deferred.length} published MCP catalog tools not disclosed to this attempt`,
    },
  ]);
  // The durable attempt record's disclosure lists stay small with a full publication (#1267).
  const recorded = JSON.stringify({
    tools: disclosure.receipt.disclosed,
    omitted: disclosure.receipt.omitted,
    mcpPreparation: disclosure.receipt.mcpPreparation,
  });
  expect(Buffer.byteLength(recorded)).toBeLessThan(4 * 1024);
});
