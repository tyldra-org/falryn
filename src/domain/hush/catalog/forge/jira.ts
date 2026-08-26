/** Hush command-catalog policy for forge.jira. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FORGE_JIRA_POLICY = {
  reducerId: "forge.jira",
  family: "github",
  projection: "forge",
  executables: ["jira"],
  examples: ["jira issue list", "jira issue view FAL-1"],
} as const satisfies HushCatalogEntry;
