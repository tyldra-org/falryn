/** Hush command-catalog policy for format.generic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FORMAT_GENERIC_POLICY = {
  reducerId: "format.generic",
  family: "lint",
  projection: "diagnostic",
  executables: ["format", "lint"],
  examples: ["format --check .", "lint src"],
} as const satisfies HushCatalogEntry;
