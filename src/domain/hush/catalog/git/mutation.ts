/** Hush command-catalog policy for git.mutation. */

import { gitSubcommand } from "../../git-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

const GIT_MUTATIONS = new Set([
  "add",
  "branch",
  "checkout",
  "commit",
  "fetch",
  "pull",
  "push",
  "stash",
  "worktree",
]);

export const GIT_MUTATION_POLICY = {
  reducerId: "git.mutation",
  family: "git",
  projection: "git-mutation",
  executables: ["git", "yadm"],
  examples: [
    "git add .",
    "git commit -m change",
    "git checkout main",
    "git push",
    "git pull",
    "git branch",
    "git fetch",
    "git stash list",
    "git worktree list",
  ],
  matches: (tokens) => GIT_MUTATIONS.has(gitSubcommand(tokens)),
} as const satisfies HushCatalogEntry;
