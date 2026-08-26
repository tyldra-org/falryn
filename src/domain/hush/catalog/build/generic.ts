/** Hush command-catalog policy for build.generic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUILD_GENERIC_POLICY = {
  reducerId: "build.generic",
  family: "build",
  projection: "build",
  executables: ["build"],
  examples: ["build"],
} as const satisfies HushCatalogEntry;
