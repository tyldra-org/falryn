/** Hush command-catalog policy for files.rg. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_RG_POLICY = {
  reducerId: "files.rg",
  family: "search",
  projection: "search",
  executables: ["rg", "ripgrep"],
  examples: ["rg 'TODO' src"],
} as const satisfies HushCatalogEntry;
