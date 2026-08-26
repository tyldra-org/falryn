/** Hush command-catalog policy for files.ls. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_LS_POLICY = {
  reducerId: "files.ls",
  family: "listing",
  projection: "ls",
  executables: ["ls"],
  examples: ["ls", "ls -la", "ls -R workspace"],
} as const satisfies HushCatalogEntry;
