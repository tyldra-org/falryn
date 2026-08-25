import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { passthroughProjection } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { githubCommand } from "../../github-command.ts";
import { gitlabCommand } from "../../gitlab-command.ts";
import { graphiteCommand } from "../../graphite-command.ts";
import { tableProjection } from "../table/projection.ts";
import { githubProjection } from "./github/projection.ts";
import { gitlabProjection } from "./gitlab/projection.ts";
import { graphiteProjection } from "./graphite/projection.ts";

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
  return graphiteCommand(commandTokens) === null
    ? tableProjection(capture, maxBytes, patterns)
    : passthroughProjection(capture, maxBytes, patterns);
}
