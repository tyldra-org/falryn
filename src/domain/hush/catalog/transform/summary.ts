/** Hush command-catalog policy for transform.summary. */

import type { HushCatalogEntry } from "../contracts.ts";

export const TRANSFORM_SUMMARY_POLICY = {
  reducerId: "transform.summary",
  family: "build",
  projection: "operation",
  executables: ["err"],
  examples: ["err make"],
} as const satisfies HushCatalogEntry;
