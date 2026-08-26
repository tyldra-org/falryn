/** Hush command-catalog policy for files.diff. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_DIFF_POLICY = {
  reducerId: "files.diff",
  family: "listing",
  projection: "git-diff",
  executables: ["diff"],
  examples: ["diff before.ts after.ts"],
} as const satisfies HushCatalogEntry;
