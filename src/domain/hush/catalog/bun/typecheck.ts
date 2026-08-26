/** Hush command-catalog policy for bun.typecheck. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUN_TYPECHECK_POLICY = {
  reducerId: "bun.typecheck",
  family: "typecheck",
  projection: "diagnostic",
  executables: ["bun"],
  examples: ["bun run typecheck"],
  matches: (tokens) => tokens[1] === "run" && tokens[2] === "typecheck",
} as const satisfies HushCatalogEntry;
