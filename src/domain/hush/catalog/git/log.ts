/** Hush command-catalog policy for git.log. */

import { gitSubcommand } from "../../git-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

export const GIT_LOG_POLICY = {
  reducerId: "git.log",
  family: "git",
  projection: "git-log",
  executables: ["git", "yadm"],
  examples: ["git log -10", "git show HEAD", "yadm log"],
  matches: (tokens) => ["log", "show"].includes(gitSubcommand(tokens)),
} as const satisfies HushCatalogEntry;
