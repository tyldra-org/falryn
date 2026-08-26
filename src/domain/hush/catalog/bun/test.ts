/** Hush command-catalog policy for bun.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUN_TEST_POLICY = {
  reducerId: "bun.test",
  family: "test",
  projection: "test",
  executables: ["bun"],
  examples: ["bun test"],
  matches: (tokens) => tokens[1] === "test",
} as const satisfies HushCatalogEntry;
