/** Hush command-catalog policy for files.grep. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_GREP_POLICY = {
  reducerId: "files.grep",
  family: "search",
  projection: "search",
  executables: ["grep", "ag"],
  examples: ["grep -R TODO src"],
} as const satisfies HushCatalogEntry;
