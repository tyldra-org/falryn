/** Hush command-catalog policy for transform.log. */

import type { HushCatalogEntry } from "../contracts.ts";

export const TRANSFORM_LOG_POLICY = {
  reducerId: "transform.log",
  family: "log",
  projection: "log",
  executables: ["journalctl"],
  examples: ["journalctl -u falryn"],
} as const satisfies HushCatalogEntry;
