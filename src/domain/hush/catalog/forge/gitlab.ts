/** Hush command-catalog policy for forge.gitlab. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FORGE_GITLAB_POLICY = {
  reducerId: "forge.gitlab",
  family: "github",
  projection: "forge",
  executables: ["glab"],
  examples: [
    "glab mr list",
    "glab issue list",
    "glab ci status",
    "glab pipeline list",
    "glab api projects",
    "glab release list",
  ],
} as const satisfies HushCatalogEntry;
