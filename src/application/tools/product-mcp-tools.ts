import { z } from "zod";
import {
  MCP_DEADLINE_MS,
  type McpAdmission,
  mcpMethodSchema,
} from "../../domain/extensions/mcp.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import type { McpLifecycle } from "../extensions/mcp-lifecycle.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { boundedProtocolObjectSchema } from "./product-language-tools/contracts.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

const identity = z.string().min(1).max(64);
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
const definitions = [
  {
    name: "mcp_inspect",
    description:
      "Inspect configured MCP connection identities and lifecycle state without starting any server.",
    schema: z.strictObject({}),
    effect: "observation" as const,
  },
  {
    name: "mcp_connect",
    description:
      "Start an enabled configured MCP connection, validate its protocol, and return its transport generation. Use only for a relevant task.",
    schema: z.strictObject({
      serverId: identity,
      configurationGeneration: z.number().int().nonnegative(),
    }),
    effect: "external" as const,
  },
  {
    name: "mcp_request",
    description:
      "Send one MCP request to an admitted transport generation. Tool calls require normal external-effect approval. Never resend an uncertain call.",
    schema: z.strictObject({
      serverId: identity,
      configurationGeneration: z.number().int().nonnegative(),
      transportGeneration: z.number().int().positive(),
      method: mcpMethodSchema,
      paramsJson: paramsSchema,
    }),
    effect: "external" as const,
  },
  {
    name: "mcp_stop",
    description: "Stop a selected MCP connection and cancel its pending requests.",
    schema: z.strictObject({ serverId: identity }),
    effect: "external" as const,
  },
];
export function composeProductMcpTools(
  generation: ConfigurationGeneration,
  lifecycle: McpLifecycle,
): ProductToolSourceBundle {
  const entries = definitions.map((definition) => {
    const entry = createToolRegistryEntry(
      {
        namespace: "extensions",
        name: definition.name,
        version: 1,
        source: "builtin",
        title: definition.name,
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
    if (!entry.ok) throw new Error(`mcp-tool-registration-${entry.error.code}`);
    return entry.value;
  });
  const registered = createToolRegistry(generation, entries);
  if (!registered.ok) throw new Error(`mcp-registry-${registered.error.code}`);
  const registry = registered.value;
  return {
    registry,
    catalog: registry.catalog,
    explicitOnly: new Set(entries.map((entry) => entry.manifest.capabilityId)),
    toolNames: definitions.map((item) => item.name),
    runner: {
      hasBinding: (id) => registry.resolveByCapabilityId(id) !== null,
      async execute(request: ToolRunnerRequest) {
        const definition = definitions.find((item) => item.name === request.toolName);
        const entry = registry.resolveByName(request.toolName);
        if (
          !definition ||
          entry?.manifest.capabilityId !== request.capabilityId ||
          entry.manifest.version !== request.version
        )
          return { status: "unavailable", reason: "mcp-binding-mismatch", effect: "none" };
        const parsed = definition.schema.safeParse(request.input);
        if (!parsed.success)
          return { status: "malformed", reason: "mcp-malformed-input", effect: "none" };
        if (request.signal.aborted) return { status: "cancelled", effect: "none" };
        const input = request.input;
        const admission: McpAdmission = {
          serverId: String(input.serverId ?? ""),
          configurationGeneration: Number(input.configurationGeneration ?? generation),
          origin: "model",
          requestId: String(request.invocationId),
          deadline: Math.min(
            Date.now() + MCP_DEADLINE_MS,
            request.processTask?.deadline ?? Infinity,
          ),
          signal: request.signal,
        };
        const result =
          request.toolName === "mcp_inspect"
            ? lifecycle.inspect()
            : request.toolName === "mcp_connect"
              ? await lifecycle.connect(admission)
              : request.toolName === "mcp_stop"
                ? await lifecycle.stop(admission.serverId)
                : await lifecycle.request(
                    admission,
                    Number(input.transportGeneration),
                    mcpMethodSchema.parse(input.method),
                    boundedProtocolObjectSchema.parse(JSON.parse(String(input.paramsJson))),
                  );
        if (!Array.isArray(result) && "kind" in result && result.kind !== "completed") {
          request.processTask?.reportTermination?.(result.effect === "none");
          if (result.effect === "uncertain" && result.kind === "stale")
            return { status: "failed", reason: result.code, effect: "uncertain" };
          if (result.kind === "stale" || result.kind === "denied" || result.kind === "unavailable")
            return { status: "unavailable", reason: result.code, effect: "none" };
          if (result.kind === "cancelled") return { status: "cancelled", effect: result.effect };
          if (result.kind === "timed-out") return { status: "timed-out", effect: result.effect };
          return { status: "failed", reason: result.code, effect: result.effect };
        }
        return { status: "completed", output: { result }, effect: "completed" };
      },
    },
  };
}
