import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import {
  gitlabCommand,
  gitlabCommandArguments,
  type HushGitlabCommand,
  hasGitlabOutputOverride,
} from "../../../command/gitlab.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { boundStream, boundText, joinStreams } from "../../stream.ts";
import { completeSuccessfulCapture } from "../capture.ts";
import { formatGitlabCiStatus } from "./ci-status.ts";
import { formatGitlabIssueList } from "./issue-list.ts";
import { formatGitlabMrList } from "./mr-list.ts";
import { formatGitlabPipelineList } from "./pipeline-list.ts";
import { formatGitlabReleaseList } from "./release-list.ts";

export function gitlabProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection | null {
  const command = gitlabCommand(commandTokens);
  if (
    command === null ||
    patterns.length > 0 ||
    hasGitlabOutputOverride(command, gitlabCommandArguments(commandTokens)) ||
    !completeSuccessfulCapture(capture)
  ) {
    return null;
  }
  const source = capture.stdout.inlineText;
  if (source === null) {
    return null;
  }
  const formatted = formatGitlab(command, source, gitlabCommandArguments(commandTokens));
  if (formatted === null) {
    return null;
  }
  return joinStreams(
    boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, [], false),
    maxBytes,
  );
}

function formatGitlab(
  command: HushGitlabCommand,
  source: string,
  args: readonly string[],
): string | null {
  switch (command) {
    case "mr-list":
      return formatGitlabMrList(source, args);
    case "issue-list":
      return formatGitlabIssueList(source, args);
    case "ci-status":
      return formatGitlabCiStatus(source);
    case "pipeline-list":
      return formatGitlabPipelineList(source);
    case "release-list":
      return formatGitlabReleaseList(source);
    case "api":
      return null;
  }
}
