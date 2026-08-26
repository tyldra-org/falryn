/** Hush command-catalog policy for data.json. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DATA_JSON_POLICY = {
  reducerId: "data.json",
  family: "data",
  projection: "json",
  executables: ["json"],
  examples: ["json package.json"],
} as const satisfies HushCatalogEntry;
