/** Hush command-catalog policy for js.format. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_FORMAT_POLICY = {
  reducerId: "js.format",
  family: "lint",
  projection: "diagnostic",
  executables: ["prettier"],
  examples: ["prettier --check ."],
} as const satisfies HushCatalogEntry;
