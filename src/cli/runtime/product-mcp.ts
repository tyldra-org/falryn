import { createMcpLifecycle } from "../../application/extensions/mcp-lifecycle.ts";
import { composeProductMcpTools } from "../../application/tools/product-mcp-tools.ts";
import type {
  ConfigurationGenerationRecord,
  ConfigurationValues,
} from "../../domain/configuration/index.ts";
import type { ConfigurationGeneration, EnvironmentPort } from "../../domain/foundation/index.ts";
import type { ManagedServicePort } from "../../domain/process/index.ts";
import { createHostMcpClient } from "../../integrations/extensions/mcp-client.ts";
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
  readonly environment: EnvironmentPort;
  readonly authorize: (signal: AbortSignal) => Promise<boolean>;
}) {
  const lifecycle = createMcpLifecycle({
    configuration() {
      const config = options.configuration();
      return mcpConfiguration(config.values, config.generation, config.record);
    },
    authorize: (admission) => options.authorize(admission.signal),
    clients: createHostMcpClient({
      identity: options.identity,
      environment: options.environment,
      environmentGeneration: options.context.generation,
      currentEnvironmentGeneration: options.context.currentGeneration,
      environmentValues: options.context.values,
      services: (names) =>
        options.context.services(options.services, (name) => names.includes(name)),
    }),
  });
  return {
    lifecycle,
    tools: composeProductMcpTools(options.generation, lifecycle),
    close: lifecycle.close,
  };
}
