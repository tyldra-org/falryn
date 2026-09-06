/** Forge and issue-tracker command rules. */

import { reduceForge } from "../reducers/forge/reduce.ts";
import { defineCommandRule } from "./contracts.ts";

export const FORGE_RULES = [
  defineCommandRule(
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
    reduceForge,
  ),
  defineCommandRule(
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
    reduceForge,
  ),
  defineCommandRule(
    {
      reducerId: "forge.graphite",
      family: "github",
      projection: "forge",
      executables: ["gt"],
      examples: ["gt log", "gt submit", "gt sync", "gt restack", "gt create", "gt branch"],
    },
    reduceForge,
  ),
] as const;

export const JIRA_RULES = [
  defineCommandRule(
    {
      reducerId: "forge.jira",
      family: "github",
      projection: "forge",
      executables: ["jira"],
      examples: ["jira issue list", "jira issue view FAL-1"],
    },
    reduceForge,
  ),
] as const;
