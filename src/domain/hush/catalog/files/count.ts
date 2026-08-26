/** Hush command-catalog policy for files.count. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_COUNT_POLICY = {
  reducerId: "files.count",
  family: "data",
  projection: "count",
  executables: ["wc"],
  examples: ["wc -l src/main.ts"],
} as const satisfies HushCatalogEntry;
