/** Hush command-catalog policy for elixir.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const ELIXIR_DIAGNOSTIC_POLICY = {
  reducerId: "elixir.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["mix"],
  examples: ["mix format"],
  matches: (tokens) => tokens[1] === "format",
} as const satisfies HushCatalogEntry;
