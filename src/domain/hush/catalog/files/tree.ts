/** Hush command-catalog policy for files.tree. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_TREE_POLICY = {
  reducerId: "files.tree",
  family: "listing",
  projection: "tree",
  executables: ["tree"],
  examples: ["tree", "tree -L 3"],
} as const satisfies HushCatalogEntry;
