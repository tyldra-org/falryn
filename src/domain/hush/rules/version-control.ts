/** Git, yadm, and Jujutsu command rules. */

import { gitSubcommand } from "../command/git.ts";
import {
  reduceGitDiff,
  reduceGitLog,
  reduceGitMutation,
  reduceGitStatus,
} from "../reducers/entrypoints.ts";
import { defineCommandRule } from "./contracts.ts";

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

export const GIT_RULES = [
  defineCommandRule(
    {
      reducerId: "git.diff",
      family: "git",
      projection: "git-diff",
      executables: ["git", "yadm"],
      examples: ["git diff", "git -C workspace diff --stat", "yadm diff"],
      matches: (tokens) => gitSubcommand(tokens) === "diff",
    },
    reduceGitDiff,
  ),
  defineCommandRule(
    {
      reducerId: "git.status",
      family: "git",
      projection: "git-status",
      executables: ["git", "yadm"],
      examples: ["git status --short", "yadm status"],
      matches: (tokens) => gitSubcommand(tokens) === "status",
    },
    reduceGitStatus,
  ),
  defineCommandRule(
    {
      reducerId: "git.log",
      family: "git",
      projection: "git-log",
      executables: ["git", "yadm"],
      examples: ["git log -10", "git show HEAD", "yadm log"],
      matches: (tokens) => ["log", "show"].includes(gitSubcommand(tokens)),
    },
    reduceGitLog,
  ),
  defineCommandRule(
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
    reduceGitMutation,
  ),
] as const;

export const JUJUTSU_RULES = [
  defineCommandRule(
    {
      reducerId: "vcs.jujutsu.diff",
      family: "git",
      projection: "git-diff",
      executables: ["jj"],
      examples: ["jj diff"],
      matches: (tokens) => tokens[1] === "diff",
    },
    reduceGitDiff,
  ),
  defineCommandRule(
    {
      reducerId: "vcs.jujutsu.log",
      family: "git",
      projection: "git-log",
      executables: ["jj"],
      examples: ["jj log"],
    },
    reduceGitLog,
  ),
] as const;
