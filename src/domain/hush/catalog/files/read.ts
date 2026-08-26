/** Hush command-catalog policy for files.read. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_READ_POLICY = {
  reducerId: "files.read",
  family: "listing",
  projection: "read",
  executables: ["cat", "head", "bat"],
  examples: ["cat README.md", "head -20 src/main.ts", "bat src/main.ts"],
} as const satisfies HushCatalogEntry;
