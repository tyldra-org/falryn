/** Hush command-catalog policy for bun.lint. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUN_LINT_POLICY = {
  reducerId: "bun.lint",
  family: "lint",
  projection: "diagnostic",
  executables: ["bun"],
  examples: ["bun run check", "bun run lint"],
  matches: (tokens) => tokens[1] === "run" && (tokens[2] === "check" || tokens[2] === "lint"),
} as const satisfies HushCatalogEntry;
