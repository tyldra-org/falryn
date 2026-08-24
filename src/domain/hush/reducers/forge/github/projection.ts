import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../../bounds.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  githubCommand,
  githubCommandArguments,
  hasGithubOutputOverride,
} from "../../../github-command.ts";
import { formatGithubIssueList } from "./issue-list.ts";
import { formatGithubPrList } from "./pr-list.ts";
import { formatGithubPrView } from "./pr-view.ts";
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
    !canProject(capture)
  ) {
    return null;
  }
  const source = capture.stdout.inlineText;
  if (source === null) {
    return null;
  }
  const formatted =
    command === "pr-list"
      ? formatGithubPrList(source)
      : command === "pr-view"
        ? formatGithubPrView(source)
        : command === "issue-list"
          ? formatGithubIssueList(source)
          : formatGithubRunList(source);
  if (formatted === null) {
    return null;
  }
  return joinStreams(
    boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, [], false),
    maxBytes,
  );
}

function canProject(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

function completeText(capture: ProcessStreamCapture): boolean {
  return (
    capture.encoding === "utf-8" &&
    capture.inlineText !== null &&
    !capture.truncated &&
    capture.omittedBytes === 0 &&
    !capture.maxLineExceeded
  );
}
