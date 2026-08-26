/** Hush command-catalog policy for network.wget. */

import type { HushCatalogEntry } from "../contracts.ts";

export const NETWORK_WGET_POLICY = {
  reducerId: "network.wget",
  family: "http",
  projection: "wget",
  executables: ["wget"],
  examples: ["wget https://example.com/file"],
} as const satisfies HushCatalogEntry;
