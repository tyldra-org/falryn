/** Hush command-catalog policy for git.status. */

import { gitSubcommand } from "../../git-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

export const GIT_STATUS_POLICY = {
  reducerId: "git.status",
  family: "git",
  projection: "git-status",
  executables: ["git", "yadm"],
  examples: ["git status --short", "yadm status"],
  matches: (tokens) => gitSubcommand(tokens) === "status",
} as const satisfies HushCatalogEntry;
