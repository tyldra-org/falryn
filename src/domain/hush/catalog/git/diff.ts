/** Hush command-catalog policy for git.diff. */

import { gitSubcommand } from "../../git-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

export const GIT_DIFF_POLICY = {
  reducerId: "git.diff",
  family: "git",
  projection: "git-diff",
  executables: ["git", "yadm"],
  examples: ["git diff", "git -C workspace diff --stat", "yadm diff"],
  matches: (tokens) => gitSubcommand(tokens) === "diff",
} as const satisfies HushCatalogEntry;
