/** Ordered Hush catalog group preserving executable matcher precedence. */

import type { HushCatalogEntry } from "../contracts.ts";
import { FORGE_GITHUB_POLICY } from "../forge/github.ts";
import { FORGE_GITLAB_POLICY } from "../forge/gitlab.ts";
import { FORGE_GRAPHITE_POLICY } from "../forge/graphite.ts";
import { FORGE_JIRA_POLICY } from "../forge/jira.ts";
import { GIT_DIFF_POLICY } from "../git/diff.ts";
import { GIT_LOG_POLICY } from "../git/log.ts";
import { GIT_MUTATION_POLICY } from "../git/mutation.ts";
import { GIT_STATUS_POLICY } from "../git/status.ts";
import { VCS_JUJUTSU_DIFF_POLICY } from "../vcs/jujutsu/diff.ts";
import { VCS_JUJUTSU_LOG_POLICY } from "../vcs/jujutsu/log.ts";

export const VERSION_CONTROL_COMMANDS = [
  GIT_DIFF_POLICY,
  GIT_STATUS_POLICY,
  GIT_LOG_POLICY,
  GIT_MUTATION_POLICY,
  FORGE_GITHUB_POLICY,
  FORGE_GITLAB_POLICY,
  FORGE_GRAPHITE_POLICY,
  VCS_JUJUTSU_DIFF_POLICY,
  VCS_JUJUTSU_LOG_POLICY,
  FORGE_JIRA_POLICY,
] as const satisfies readonly HushCatalogEntry[];
