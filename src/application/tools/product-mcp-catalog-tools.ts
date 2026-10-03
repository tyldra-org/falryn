/**
 * Publish current MCP catalog tools as model tools (#1157).
 *
 * Each published definition binds one exact catalog entry, catalog generation and schema
 * digest, and executes through the `mcp_call_tool` owner path: confirmation, resources,
 * user input, hooks and receipts are unchanged. Only current catalogs contribute; at most
 * `MCP_PREPARATION_LIMITS.publishedTools` definitions are published per registry.
 */
import { z } from "zod";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { McpConnection } from "../../domain/extensions/mcp.ts";
import { MCP_INPUT_LIMITS } from "../../domain/extensions/mcp-input.ts";
import {
  MCP_PREPARATION_LIMITS,
  type McpCatalogToolCounts,
} from "../../domain/extensions/mcp-preparation.ts";
import type { CapabilityId, ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import type { McpCatalog } from "../extensions/mcp-catalog.ts";
import type { ProductMcpTools } from "./product-mcp-tools.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

/** Bounded untrusted description length for one published MCP tool. */
const DESCRIPTION_CHARACTERS = 256;

function slug(value: string, maximum: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maximum)
    .replace(/-+$/u, "");
  return cleaned.length === 0 ? "x" : cleaned;
}

/**
 * A provider-safe name (lowercase `[a-z0-9_-]`, at most 64 characters). The hash binds the
 * entry identity and schema digest, so an unchanged entry keeps its name across generations.
 */
export function mcpCatalogToolName(
  serverId: string,
  toolName: string,
  entryId: string,
  schemaDigest: string,
): string {
  const hash = canonicalDigest({ entryId, schemaDigest }).slice(7, 15);
  return `mcp_${slug(serverId, 16)}_${slug(toolName, 24)}_${hash}`;
}

function bounded(text: string): string {
  return Array.from(text).slice(0, DESCRIPTION_CHARACTERS).join("");
}

export type McpCatalogToolPublication = {
  readonly bundle: ProductToolSourceBundle;
  readonly counts: McpCatalogToolCounts;
};

export function composeMcpCatalogTools(options: {
  readonly generation: ConfigurationGeneration;
  readonly catalog: Pick<McpCatalog, "currentTools">;
  readonly servers: readonly McpConnection[];
  readonly owner: Pick<ProductMcpTools, "callCatalogTool">;
  /** Servers the user selected for this turn; only they publish explicit-only tools. */
  readonly selectedServers: readonly string[];
}): McpCatalogToolPublication {
  const configured = new Map(
    options.servers.map((server, index) => [server.id, { server, index }]),
  );
  const selected = new Set(options.selectedServers);
  const counts = { published: 0, overflow: 0, unsupported: 0, withheld: 0 };
  const candidates = options.catalog
    .currentTools()
    .flatMap((item) => {
      const owner = configured.get(item.serverId);
      if (owner === undefined || !owner.server.enabled) return [];
      if (owner.server.explicitOnly && !selected.has(item.serverId)) {
        counts.withheld++;
        return [];
      }
      if (item.entry.inputSchema === null || item.entry.schemaDigest === null) {
        counts.unsupported++;
        return [];
      }
      return [{ ...item, order: selected.has(item.serverId) ? -1 : owner.index }];
    })
    // Stable: user-selected servers first, then configuration order, then catalog order.
    .map((item, position) => ({ item, position }))
    .sort((left, right) => left.item.order - right.item.order || left.position - right.position)
    .map(({ item }) => item);

  const entries: ToolRegistryEntry[] = [];
  const bindings = new Map<
    string,
    { readonly entryId: string; readonly catalogGeneration: number; readonly schemaDigest: string }
  >();
  for (const { serverId, catalogGeneration, entry } of candidates) {
    if (entries.length >= MCP_PREPARATION_LIMITS.publishedTools) {
      counts.overflow++;
      continue;
    }
    const schemaDigest = entry.schemaDigest as string;
    const name = mcpCatalogToolName(serverId, entry.name, entry.id, schemaDigest);
    if (bindings.has(name)) continue;
    let inputSchema: z.ZodObject;
    try {
      const converted = z.fromJSONSchema(
        entry.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
      );
      // Normalized MCP input schemas are closed objects; anything else is not publishable.
      if (!(converted instanceof z.ZodObject)) throw new Error("not-an-object");
      inputSchema = converted;
    } catch {
      counts.unsupported++;
      continue;
    }
    const label = entry.title ?? entry.name;
    const built = createToolRegistryEntry(
      {
        namespace: "mcp",
        name,
        version: 1,
        source: "mcp",
        title: bounded(`${serverId}/${entry.name}`).slice(0, 128),
        description: bounded(
          `MCP tool "${label}" on server "${serverId}". External effect; needs approval. Server description (untrusted): ${entry.description ?? "none"}`,
        ),
        effect: "external",
        capabilityKind: "mcp",
        platforms: [],
        limits: defaultToolLimits({
          maxInputBytes: 256 * 1024,
          defaultTimeoutMs: MCP_INPUT_LIMITS.callCeilingMs,
          maxOutputBytes: 1024 * 1024,
        }),
        concurrency: defaultConcurrencyContract({ maxPerWorkspace: 16 }),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema,
        outputSchema: z.strictObject({ result: z.json() }),
      },
    );
    if (!built.ok) {
      counts.unsupported++;
      continue;
    }
    entries.push(built.value);
    bindings.set(name, { entryId: entry.id, catalogGeneration, schemaDigest });
  }
  counts.published = entries.length;
  const registered = createToolRegistry(options.generation, entries);
  if (!registered.ok) throw new Error(`mcp-catalog-registry-${registered.error.code}`);
  const registry = registered.value;
  const ids = new Set<CapabilityId>(entries.map((entry) => entry.manifest.capabilityId));
  return {
    counts,
    bundle: {
      registry,
      catalog: registry.catalog,
      toolNames: entries.map((entry) => entry.manifest.name),
      // The user authored these connections; ecosystem package trust does not govern them.
      userAuthorized: ids,
      runner: {
        hasBinding: (id) => ids.has(id),
        async execute(request) {
          const entry = registry.resolveByName(request.toolName);
          const binding = bindings.get(request.toolName);
          if (
            entry === null ||
            binding === undefined ||
            entry.manifest.capabilityId !== request.capabilityId ||
            entry.manifest.version !== request.version
          )
            return { status: "unavailable", reason: "mcp-binding-mismatch", effect: "none" };
          return options.owner.callCatalogTool(request, binding);
        },
      },
    },
  };
}
