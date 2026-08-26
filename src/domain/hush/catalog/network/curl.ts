/** Hush command-catalog policy for network.curl. */

import type { HushCatalogEntry } from "../contracts.ts";

export const NETWORK_CURL_POLICY = {
  reducerId: "network.curl",
  family: "http",
  projection: "curl",
  executables: ["curl"],
  examples: ["curl https://example.com"],
} as const satisfies HushCatalogEntry;
