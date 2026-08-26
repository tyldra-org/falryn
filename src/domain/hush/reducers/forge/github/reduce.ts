import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import {
  githubCommand,
  githubCommandArguments,
  type HushGithubCommand,
  hasGithubOutputOverride,
} from "../../../command/github.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { boundStream, boundText, joinStreams } from "../../stream.ts";
import { completeSuccessfulCapture } from "../capture.ts";
import { formatGithubIssueList } from "./issue-list.ts";
import { formatGithubPrList } from "./pr-list.ts";
import { formatGithubPrView } from "./pr-view.ts";
import { formatGithubReleaseList } from "./release-list.ts";
import { formatGithubRepoView } from "./repo-view.ts";
import { formatGithubRunList } from "./run-list.ts";

export function githubProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection | null {
  const command = githubCommand(commandTokens);
  if (
    command === null ||
    patterns.length > 0 ||
    hasGithubOutputOverride(command, githubCommandArguments(commandTokens)) ||
    !completeSuccessfulCapture(capture)
  ) {
    return null;
  }
  const source = capture.stdout.inlineText;
  if (source === null) {
    return null;
  }
  const args = githubCommandArguments(commandTokens);
  const formatted = formatGithub(command, source, args);
  if (formatted === null) {
    return null;
  }
  return joinStreams(
    boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, [], false),
    maxBytes,
  );
}

function formatGithub(
  command: HushGithubCommand,
  source: string,
  args: readonly string[],
): string | null {
  switch (command) {
    case "pr-list":
      return formatGithubPrList(source, args);
    case "pr-view":
      return formatGithubPrView(source);
    case "issue-list":
      return formatGithubIssueList(source, args);
    case "run-list":
      return formatGithubRunList(source);
    case "repo-view":
      return formatGithubRepoView(source);
    case "release-list":
      return formatGithubReleaseList(source);
    case "api":
      return null;
  }
}
