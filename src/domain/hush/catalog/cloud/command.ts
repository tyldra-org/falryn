/** Hush command-catalog policy for cloud.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const CLOUD_COMMAND_POLICY = {
  reducerId: "cloud.command",
  family: "cloud",
  projection: "structured",
  executables: ["gcloud", "az"],
  examples: ["gcloud projects list", "az group list"],
} as const satisfies HushCatalogEntry;
