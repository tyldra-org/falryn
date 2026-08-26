/** Hush command-catalog policy for system.table. */

import type { HushCatalogEntry } from "../contracts.ts";

export const SYSTEM_TABLE_POLICY = {
  reducerId: "system.table",
  family: "data",
  projection: "table",
  executables: ["df", "du", "ps", "stat", "systemctl"],
  examples: ["df -h", "du -sh .", "ps aux", "stat file", "systemctl status falryn"],
} as const satisfies HushCatalogEntry;
