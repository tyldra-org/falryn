/** Hush command-catalog policy for js.lint. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_LINT_POLICY = {
  reducerId: "js.lint",
  family: "lint",
  projection: "diagnostic",
  executables: ["biome", "eslint", "oxlint"],
  examples: ["biome check .", "eslint src", "oxlint src"],
} as const satisfies HushCatalogEntry;
