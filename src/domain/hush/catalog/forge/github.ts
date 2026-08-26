/** Hush command-catalog policy for forge.github. */

import type { HushCatalogEntry } from "../contracts.ts";

export const FORGE_GITHUB_POLICY = {
  reducerId: "forge.github",
  family: "github",
  projection: "forge",
  executables: ["gh"],
  examples: [
    "gh pr list",
    "gh pr view 42",
    "gh issue list",
    "gh run list",
    "gh repo view",
    "gh api repos/owner/repo",
    "gh release list",
  ],
} as const satisfies HushCatalogEntry;
