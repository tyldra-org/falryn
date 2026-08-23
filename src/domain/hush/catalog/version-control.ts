/** Version-control and forge command policies. */

import type { HushCatalogEntry } from "./contracts.ts";

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_FLAGS = new Set([
  "--bare",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
]);
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

function gitSubcommand(tokens: readonly string[]): string {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const normalized = token.split("=", 1)[0] ?? token;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(normalized)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    return token.toLowerCase();
  }
  return "";
}
