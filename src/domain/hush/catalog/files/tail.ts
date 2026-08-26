/** Hush command-catalog policy for files.tail. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_TAIL_POLICY = {
  reducerId: "files.tail",
  family: "log",
  projection: "log",
  executables: ["tail"],
  examples: ["tail -n 20 app.log"],
} as const satisfies HushCatalogEntry;
