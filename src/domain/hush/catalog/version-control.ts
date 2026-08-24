/** Version-control and forge command policies. */

import { gitSubcommand } from "../git-command.ts";
import type { HushCatalogEntry } from "./contracts.ts";

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

export const VERSION_CONTROL_COMMANDS = [
  {
    reducerId: "git.diff",
    family: "git",
    projection: "git-diff",
    executables: ["git", "yadm"],
    examples: ["git diff", "git -C workspace diff --stat", "yadm diff"],
    matches: (tokens) => gitSubcommand(tokens) === "diff",
  },
  {
    reducerId: "git.status",
    family: "git",
    projection: "git-status",
    executables: ["git", "yadm"],
    examples: ["git status --short", "yadm status"],
    matches: (tokens) => gitSubcommand(tokens) === "status",
  },
  {
    reducerId: "git.log",
    family: "git",
    projection: "git-log",
    executables: ["git", "yadm"],
    examples: ["git log -10", "git show HEAD", "yadm log"],
    matches: (tokens) => ["log", "show"].includes(gitSubcommand(tokens)),
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    reducerId: "forge.graphite",
    family: "github",
    projection: "forge",
    executables: ["gt"],
    examples: ["gt log", "gt submit", "gt sync", "gt restack", "gt create", "gt branch"],
  },
  {
    reducerId: "vcs.jujutsu.diff",
    family: "git",
    projection: "git-diff",
    executables: ["jj"],
    examples: ["jj diff"],
    matches: (tokens) => tokens[1] === "diff",
  },
  {
    reducerId: "vcs.jujutsu.log",
    family: "git",
    projection: "git-log",
    executables: ["jj"],
    examples: ["jj log"],
  },
  {
    reducerId: "forge.jira",
    family: "github",
    projection: "forge",
    executables: ["jira"],
    examples: ["jira issue list", "jira issue view FAL-1"],
  },
] as const satisfies readonly HushCatalogEntry[];
