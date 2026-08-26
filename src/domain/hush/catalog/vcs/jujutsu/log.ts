/** Hush command-catalog policy for vcs.jujutsu.log. */

import type { HushCatalogEntry } from "../../contracts.ts";

export const VCS_JUJUTSU_LOG_POLICY = {
  reducerId: "vcs.jujutsu.log",
  family: "git",
  projection: "git-log",
  executables: ["jj"],
  examples: ["jj log"],
} as const satisfies HushCatalogEntry;
