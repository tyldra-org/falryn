/** Hush command-catalog policy for forge.graphite. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FORGE_GRAPHITE_POLICY = {
  reducerId: "forge.graphite",
  family: "github",
  projection: "forge",
  executables: ["gt"],
  examples: ["gt log", "gt submit", "gt sync", "gt restack", "gt create", "gt branch"],
} as const satisfies HushCatalogEntry;
