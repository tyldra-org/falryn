/** Hush command-catalog policy for files.find. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FILES_FIND_POLICY = {
  reducerId: "files.find",
  family: "listing",
  projection: "listing",
  executables: ["find"],
  examples: ["find . -name '*.ts'"],
} as const satisfies HushCatalogEntry;
