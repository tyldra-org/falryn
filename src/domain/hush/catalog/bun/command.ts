/** Hush command-catalog policy for bun.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUN_COMMAND_POLICY = {
  reducerId: "bun.command",
  family: "package",
  projection: "package",
  executables: ["bun"],
  examples: ["bun install", "bun run custom"],
} as const satisfies HushCatalogEntry;
