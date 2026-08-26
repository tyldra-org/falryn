/** Hush command-catalog policy for network.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const NETWORK_COMMAND_POLICY = {
  reducerId: "network.command",
  family: "http",
  projection: "network",
  executables: ["ping", "rsync", "ssh"],
  examples: ["ping example.com", "rsync source target", "ssh host command"],
} as const satisfies HushCatalogEntry;
