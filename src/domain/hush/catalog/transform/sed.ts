/** Hush command-catalog policy for transform.sed. */

import type { HushCatalogEntry } from "../contracts.ts";

export const TRANSFORM_SED_POLICY = {
  reducerId: "transform.sed",
  family: "data",
  projection: "transform",
  executables: ["sed"],
  examples: ["sed -n '1,40p' src/main.ts"],
} as const satisfies HushCatalogEntry;
