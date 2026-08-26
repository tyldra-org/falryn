/** Hush command-catalog policy for elixir.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const ELIXIR_BUILD_POLICY = {
  reducerId: "elixir.build",
  family: "build",
  projection: "build",
  executables: ["mix"],
  examples: ["mix compile"],
} as const satisfies HushCatalogEntry;
