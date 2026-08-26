import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  hasJiraOutputOverride,
  jiraCommand,
  jiraCommandArguments,
} from "../../../invocation/jira.ts";
import { boundStream, boundText, joinStreams } from "../../stream.ts";
import { completeSuccessfulCapture } from "../capture.ts";
import { formatJiraIssueList } from "./issue-list.ts";
import { formatJiraIssueView } from "./issue-view.ts";

export function jiraProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection | null {
  const command = jiraCommand(commandTokens);
  if (
    command === null ||
    patterns.length > 0 ||
    hasJiraOutputOverride(jiraCommandArguments(commandTokens)) ||
    !completeSuccessfulCapture(capture)
  ) {
    return null;
  }
  const source = capture.stdout.inlineText;
  if (source === null) {
    return null;
  }
  const formatted =
    command === "issue-list" ? formatJiraIssueList(source) : formatJiraIssueView(source);
  if (formatted === null) {
    return null;
  }
  return joinStreams(
    boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, [], false),
    maxBytes,
  );
}
