/** Hush command-catalog policy for vcs.jujutsu.diff. */

import type { HushCatalogEntry } from "../../contracts.ts";

export const VCS_JUJUTSU_DIFF_POLICY = {
  reducerId: "vcs.jujutsu.diff",
  family: "git",
  projection: "git-diff",
  executables: ["jj"],
  examples: ["jj diff"],
  matches: (tokens) => tokens[1] === "diff",
} as const satisfies HushCatalogEntry;
