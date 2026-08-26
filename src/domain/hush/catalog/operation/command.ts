/** Hush command-catalog policy for operation.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const OPERATION_COMMAND_POLICY = {
  reducerId: "operation.command",
  family: "build",
  projection: "operation",
  executables: ["shopify", "ollama", "java"],
  examples: ["shopify theme push", "shopify theme pull", "ollama run model", "java -jar app.jar"],
} as const satisfies HushCatalogEntry;
