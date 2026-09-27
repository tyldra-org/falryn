import { z } from "zod";
import { MCP_DEADLINE_MS, type McpOutcome } from "../../domain/extensions/mcp.ts";
import { MCP_CATALOG_ARGUMENTS, MCP_CATALOG_KINDS } from "../../domain/extensions/mcp-catalog.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/tool-pipeline.ts";
import type { McpCatalog, McpCatalogCall, McpCatalogFailure } from "../extensions/mcp-catalog.ts";
import type { McpLifecycle } from "../extensions/mcp-lifecycle.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { boundedProtocolObjectSchema } from "./product-language-tools/contracts.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

const identity = z.string().min(1).max(64);
const configurationGeneration = z.number().int().nonnegative();
const catalogGeneration = z.number().int().positive();
const entryId = z.string().min(1).max(4096);
// Name/value pairs keep the model-facing schema closed; names must be unique.
const argumentValues = z
  .array(z.strictObject({ name: z.string().min(1).max(256), value: z.string().max(16 * 1024) }))
  .max(MCP_CATALOG_ARGUMENTS)
  .refine(
    (pairs) => new Set(pairs.map((pair) => pair.name)).size === pairs.length,
    "duplicate argument name",
  )
  .default([]);
const argumentRecord = (pairs: unknown): Record<string, string> =>
  Object.fromEntries(
    (pairs as { name: string; value: string }[]).map((pair) => [pair.name, pair.value]),
  );
// The protocol payload is encoded so the model boundary retains a closed schema.
const paramsSchema = z
  .string()
  .max(256 * 1024)
  .refine((value) => {
    try {
      return boundedProtocolObjectSchema.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, "paramsJson must encode a bounded JSON object");
/** Discovery, reads and prompts have typed owners; only these methods stay generic until #130. */
const requestMethod = z.enum(["tools/call", "ping"]);
const definitions = {
  mcp_inspect: {
    description:
      "Inspect configured MCP connections and their catalog state without starting any server.",
    schema: z.strictObject({}),
    effect: "observation",
  },
  mcp_connect: {
    description:
      "Start an enabled configured MCP connection and discover its tools, resources, resource templates and prompts. Connecting an available server refreshes its catalog. Use only for a relevant task.",
    schema: z.strictObject({ serverId: identity, configurationGeneration }),
    effect: "external",
  },
  mcp_catalog: {
    description:
      'Page discovered MCP catalog entries with their kind, availability and catalog generation. Makes no server call. Read an available resource with the read tool using its readHandle as a virtual resource: {"resources":[{"kind":"virtual","uri":readHandle}]}.',
    schema: z.strictObject({
      serverId: identity.optional(),
      kind: z.enum(MCP_CATALOG_KINDS).optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    effect: "observation",
  },
  mcp_resource_template: {
    description:
      "Fill an MCP resource template from the current catalog generation with validated arguments. Returns a readHandle for the read tool. Makes no server call.",
    schema: z.strictObject({ entryId, catalogGeneration, arguments: argumentValues }),
    effect: "observation",
  },
  mcp_get_prompt: {
    description:
      "Get an MCP prompt from the current catalog generation with validated arguments. Returns its messages as context; it does not run them.",
    schema: z.strictObject({ entryId, catalogGeneration, arguments: argumentValues }),
    effect: "observation",
  },
  mcp_request: {
    description:
      "Call an MCP tool (tools/call) or ping an admitted transport generation. Tool calls require normal external-effect approval. Never resend an uncertain call.",
    schema: z.strictObject({
      serverId: identity,
      configurationGeneration,
      transportGeneration: z.number().int().positive(),
      method: requestMethod,
      paramsJson: paramsSchema,
    }),
    effect: "external",
  },
  mcp_stop: {
    description: "Stop a selected MCP connection and cancel its pending requests.",
    schema: z.strictObject({ serverId: identity }),
    effect: "external",
  },
} as const;
type McpToolName = keyof typeof definitions;
const names = Object.keys(definitions) as McpToolName[];

function completed(result: unknown): ToolInvocationOutcome {
  return { status: "completed", output: { result }, effect: "completed" };
}
function fromCatalog(result: McpCatalogFailure): ToolInvocationOutcome {
  if (result.kind === "malformed")
    return { status: "malformed", reason: result.code, effect: "none" };
  if (result.kind === "cancelled") return { status: "cancelled", effect: result.effect };
  if (result.kind === "timed-out") return { status: "timed-out", effect: result.effect };
  if (result.effect === "uncertain")
    return { status: "failed", reason: result.code, effect: "uncertain" };
  if (result.kind === "failed") return { status: "failed", reason: result.code, effect: "none" };
  return { status: "unavailable", reason: result.code, effect: "none" };
}
function fromOutcome(result: McpOutcome): ToolInvocationOutcome {
  return result.kind === "completed" ? completed(result) : fromCatalog(result);
}

export function composeProductMcpTools(
  generation: ConfigurationGeneration,
  lifecycle: McpLifecycle,
  catalog: McpCatalog,
): ProductToolSourceBundle {
  const entries = names.map((name) => {
    const definition = definitions[name];
    const entry = createToolRegistryEntry(
      {
        namespace: "extensions",
        name,
        version: 1,
        source: "builtin",
        title: name,
        description: definition.description,
        effect: definition.effect,
        capabilityKind: "mcp",
        platforms: [],
        limits: defaultToolLimits({
          defaultTimeoutMs: MCP_DEADLINE_MS,
          maxOutputBytes: 1024 * 1024,
        }),
        concurrency: defaultConcurrencyContract({ maxPerWorkspace: 16 }),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: definition.schema,
        outputSchema: z.strictObject({
          result: z.json(),
          workspaceIndex: z.json().optional(),
          languageDiagnostics: z.json().optional(),
        }),
      },
    );
    if (!entry.ok) throw new Error("mcp-tool-registration-" + entry.error.code);
    return entry.value;
  });
  const registered = createToolRegistry(generation, entries);
  if (!registered.ok) throw new Error("mcp-registry-" + registered.error.code);
  const registry = registered.value;
  return {
    registry,
    catalog: registry.catalog,
    explicitOnly: new Set(entries.map((entry) => entry.manifest.capabilityId)),
    toolNames: names,
    runner: {
      hasBinding: (id) => registry.resolveByCapabilityId(id) !== null,
      async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
        const name = names.find((item) => item === request.toolName);
        const entry = registry.resolveByName(request.toolName);
        if (
          !name ||
          entry?.manifest.capabilityId !== request.capabilityId ||
          entry.manifest.version !== request.version
        )
          return { status: "unavailable", reason: "mcp-binding-mismatch", effect: "none" };
        const parsed = definitions[name].schema.safeParse(request.input);
        if (!parsed.success)
          return { status: "malformed", reason: "mcp-malformed-input", effect: "none" };
        if (request.signal.aborted) return { status: "cancelled", effect: "none" };
        const context: McpCatalogCall = {
          origin: "model",
          requestId: String(request.invocationId),
          deadline: Math.min(
            Date.now() + MCP_DEADLINE_MS,
            request.processTask?.deadline ?? Infinity,
          ),
          signal: request.signal,
        };
        const result = await run(name, parsed.data as Record<string, unknown>, context);
        if (result.status !== "completed")
          request.processTask?.reportTermination?.(result.effect === "none");
        return result;
      },
    },
  };

  async function run(
    name: McpToolName,
    input: Record<string, unknown>,
    context: McpCatalogCall,
  ): Promise<ToolInvocationOutcome> {
    const serverId = String(input.serverId ?? "");
    const admission = {
      ...context,
      serverId,
      configurationGeneration: Number(input.configurationGeneration ?? generation),
    };
    switch (name) {
      case "mcp_inspect":
        return completed({ connections: lifecycle.inspect(), catalogs: catalog.summaries() });
      case "mcp_connect": {
        const connected = await lifecycle.connect(admission);
        if (connected.kind !== "completed") return fromOutcome(connected);
        const discovered = await catalog.discover(serverId, context);
        // A connected server with a failed discovery is still connected; the catalog reports why.
        return completed({
          connection: connected.snapshot,
          catalog:
            discovered.kind === "completed"
              ? discovered.value
              : catalog.summaries().find((item) => item.serverId === serverId),
          discovery: discovered.kind === "completed" ? "completed" : discovered.code,
        });
      }
      case "mcp_catalog": {
        const page = catalog.page(input as Parameters<McpCatalog["page"]>[0]);
        return page.kind === "completed" ? completed(page.value) : fromCatalog(page);
      }
      case "mcp_resource_template": {
        const resolved = catalog.resolveTemplate(
          String(input.entryId),
          Number(input.catalogGeneration),
          argumentRecord(input.arguments),
        );
        return resolved.kind === "completed" ? completed(resolved.value) : fromCatalog(resolved);
      }
      case "mcp_get_prompt": {
        const prompt = await catalog.getPrompt(
          String(input.entryId),
          Number(input.catalogGeneration),
          argumentRecord(input.arguments),
          context,
        );
        return prompt.kind === "completed" ? completed(prompt.value) : fromCatalog(prompt);
      }
      case "mcp_request":
        return fromOutcome(
          await lifecycle.request(
            admission,
            Number(input.transportGeneration),
            requestMethod.parse(input.method),
            boundedProtocolObjectSchema.parse(JSON.parse(String(input.paramsJson))),
          ),
        );
      case "mcp_stop":
        return fromOutcome(await lifecycle.stop(serverId));
    }
  }
}
