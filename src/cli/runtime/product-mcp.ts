import { createMcpCatalog } from "../../application/extensions/mcp-catalog.ts";
import type { McpUserInput } from "../../application/extensions/mcp-input.ts";
import { createMcpLifecycle } from "../../application/extensions/mcp-lifecycle.ts";
import { prepareMcpServers } from "../../application/extensions/mcp-preparation.ts";
import { composeMcpCatalogTools } from "../../application/tools/product-mcp-catalog-tools.ts";
import { composeProductMcpTools } from "../../application/tools/product-mcp-tools.ts";
import type { ProductToolSourceBundle } from "../../application/tools/product-tools-merge.ts";
import type {
  ConfigurationGenerationRecord,
  ConfigurationValues,
} from "../../domain/configuration/index.ts";
import type { McpPreparationReceipt } from "../../domain/extensions/mcp-preparation-receipt.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import type { ManagedServicePort } from "../../domain/process/index.ts";
import type { SecretResolverPort } from "../../domain/security/credential.ts";
import type { EnvironmentProcessContext } from "./environment-process-context.ts";
import { mcpConfiguration } from "./mcp-configuration.ts";

export function composeProductMcp(options: {
  readonly identity: string;
  readonly generation: ConfigurationGeneration;
  readonly configuration: () => {
    readonly values: ConfigurationValues;
    readonly generation: number;
    readonly record?: ConfigurationGenerationRecord | null;
  };
  readonly services: ManagedServicePort;
  readonly context: EnvironmentProcessContext;
  /** The shared resolver HTTP servers' credential references are scoped through. */
  readonly credentials: SecretResolverPort;
  readonly authorize: (signal: AbortSignal) => Promise<boolean>;
  /** How tool calls ask the user for server-requested input; absent hosts cancel. */
  readonly userInput?: McpUserInput;
}) {
  const configuration = () => {
    const config = options.configuration();
    return mcpConfiguration(config.values, config.generation, config.record);
  };
  const lifecycle = createMcpLifecycle({
    configuration,
    authorize: (admission) => options.authorize(admission.signal),
    // The MCP SDK loads when the first server connects, not at process start.
    clients: async (request) => {
      const { createHostMcpClient } = await import("../../integrations/extensions/mcp-client.ts");
      return createHostMcpClient({
        identity: options.identity,
        credentials: options.credentials,
        environmentGeneration: options.context.generation,
        currentEnvironmentGeneration: options.context.currentGeneration,
        environmentValues: options.context.values,
        services: (names) =>
          options.context.services(options.services, (name) => names.includes(name)),
      })(request);
    },
  });
  const catalog = createMcpCatalog({ lifecycle, configuration });
  const tools = composeProductMcpTools(options.generation, lifecycle, catalog, options.userInput);
  return {
    lifecycle,
    catalog,
    /** The resolved connection configuration, for hosts that list servers. */
    configuration,
    tools,
    /**
     * Prepare relevant servers for one turn and publish current catalog tools (#1157). With no
     * configured server this does nothing and returns null.
     */
    async prepareTurn(
      turn: {
        readonly prompt: string;
        readonly mcpServers: readonly string[];
        readonly id: string;
      },
      signal: AbortSignal,
    ): Promise<{
      readonly bundle: ProductToolSourceBundle;
      readonly receipt: McpPreparationReceipt;
    } | null> {
      const current = configuration();
      if (current.servers.length === 0) return null;
      const servers = await prepareMcpServers(
        { lifecycle, catalog, configuration },
        { task: turn.prompt, selectedServers: turn.mcpServers, requestId: turn.id, signal },
      );
      const published = composeMcpCatalogTools({
        generation: options.generation,
        catalog,
        servers: configuration().servers,
        owner: tools,
        selectedServers: turn.mcpServers,
      });
      return {
        bundle: published.bundle,
        receipt: { schemaVersion: 1, servers, tools: published.counts },
      };
    },
    /** Host-owned unified Read port for catalog resources. */
    resources: catalog.resources,
    close: lifecycle.close,
  };
}
