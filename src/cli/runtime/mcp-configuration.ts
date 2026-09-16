import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationValues,
  isUnreadSource,
} from "../../domain/configuration/index.ts";
import {
  MCP_CONNECTIONS_KEY,
  type McpConfiguration,
  mcpConfigurationSchema,
} from "../../domain/extensions/mcp.ts";

export const MCP_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: MCP_CONNECTIONS_KEY,
    summary: "User-authorized MCP connections. Inspection starts no transport.",
    objectSchema: mcpConfigurationSchema,
    defaultValue: { servers: [] },
    scopes: ["user"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
  }),
];
export function mcpConfiguration(
  values: ConfigurationValues,
  generation: number,
  record?: ConfigurationGenerationRecord | null,
): McpConfiguration {
  if (record === null || record?.sources.some(isUnreadSource))
    throw new Error("mcp-configuration-unavailable");
  return {
    generation,
    ...mcpConfigurationSchema.parse(values[MCP_CONNECTIONS_KEY] ?? { servers: [] }),
  };
}
