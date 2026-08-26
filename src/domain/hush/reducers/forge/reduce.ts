import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { githubCommand } from "../../command/github.ts";
import { gitlabCommand } from "../../command/gitlab.ts";
import { graphiteCommand } from "../../command/graphite.ts";
import { jiraCommand } from "../../command/jira.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { passthroughProjection } from "../fallback.ts";
import { tableProjection } from "../table/reduce.ts";
import { githubProjection } from "./github/reduce.ts";
import { gitlabProjection } from "./gitlab/reduce.ts";
import { graphiteProjection } from "./graphite/reduce.ts";
import { jiraProjection } from "./jira/reduce.ts";

export function forgeProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const github = githubProjection(capture, maxBytes, patterns, commandTokens);
  if (github !== null) {
    return github;
  }
  if (githubCommand(commandTokens) !== null) {
    return passthroughProjection(capture, maxBytes, patterns);
  }
  const gitlab = gitlabProjection(capture, maxBytes, patterns, commandTokens);
  if (gitlab !== null) {
    return gitlab;
  }
  if (gitlabCommand(commandTokens) !== null) {
    return passthroughProjection(capture, maxBytes, patterns);
  }
  const graphite = graphiteProjection(capture, maxBytes, patterns, commandTokens);
  if (graphite !== null) {
    return graphite;
  }
  if (graphiteCommand(commandTokens) !== null) {
    return passthroughProjection(capture, maxBytes, patterns);
  }
  const jira = jiraProjection(capture, maxBytes, patterns, commandTokens);
  if (jira !== null) {
    return jira;
  }
  return jiraCommand(commandTokens) === null
    ? tableProjection(capture, maxBytes, patterns)
    : passthroughProjection(capture, maxBytes, patterns);
}
