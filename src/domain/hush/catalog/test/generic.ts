/** Hush command-catalog policy for test.generic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const TEST_GENERIC_POLICY = {
  reducerId: "test.generic",
  family: "test",
  projection: "test",
  executables: ["test"],
  examples: ["test custom-runner"],
} as const satisfies HushCatalogEntry;
