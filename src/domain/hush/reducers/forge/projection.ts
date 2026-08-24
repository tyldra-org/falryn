import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { passthroughProjection } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { githubCommand } from "../../github-command.ts";
import { tableProjection } from "../table/projection.ts";
import { githubProjection } from "./github/projection.ts";

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
  return githubCommand(commandTokens) === null
    ? tableProjection(capture, maxBytes, patterns)
    : passthroughProjection(capture, maxBytes, patterns);
}
