/** Ordered command-reducer group mirroring the Hush catalog. */

import { FORGE_GITHUB_REDUCER } from "../forge/github.ts";
import { FORGE_GITLAB_REDUCER } from "../forge/gitlab.ts";
import { FORGE_GRAPHITE_REDUCER } from "../forge/graphite.ts";
import { FORGE_JIRA_REDUCER } from "../forge/jira.ts";
import { GIT_DIFF_REDUCER } from "../git/diff.ts";
import { GIT_LOG_REDUCER } from "../git/log.ts";
import { GIT_MUTATION_REDUCER } from "../git/mutation.ts";
import { GIT_STATUS_REDUCER } from "../git/status.ts";
import { VCS_JUJUTSU_DIFF_REDUCER } from "../vcs/jujutsu/diff.ts";
import { VCS_JUJUTSU_LOG_REDUCER } from "../vcs/jujutsu/log.ts";

export const VERSION_CONTROL_COMMAND_REDUCERS = {
  "git.diff": GIT_DIFF_REDUCER,
  "git.status": GIT_STATUS_REDUCER,
  "git.log": GIT_LOG_REDUCER,
  "git.mutation": GIT_MUTATION_REDUCER,
  "forge.github": FORGE_GITHUB_REDUCER,
  "forge.gitlab": FORGE_GITLAB_REDUCER,
  "forge.graphite": FORGE_GRAPHITE_REDUCER,
  "vcs.jujutsu.diff": VCS_JUJUTSU_DIFF_REDUCER,
  "vcs.jujutsu.log": VCS_JUJUTSU_LOG_REDUCER,
  "forge.jira": FORGE_JIRA_REDUCER,
} as const;
