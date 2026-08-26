/** Capture gate and command dispatch for Git log/show projections. */

import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import { gitSubcommand, gitSubcommandArguments } from "../../../command/git.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { genericProjection } from "../../fallback.ts";
import { shortestText } from "../../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../../stream.ts";
import { formatNativeGitLog } from "./format.ts";
import { formatNativeGitShow } from "./show.ts";

export function gitLogProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[] = [],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  if (source === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }

  const subcommand = gitSubcommand(commandTokens);
  const arguments_ = gitSubcommandArguments(commandTokens);
  const canFormat =
    isGitExecutable(commandTokens[0] ?? "") &&
    !requestsCustomPresentation(arguments_) &&
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    capture.stdout.encoding === "utf-8" &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded;
  const formatted = canFormat
    ? subcommand === "log"
      ? formatNativeGitLog(source)
      : subcommand === "show"
        ? formatNativeGitShow(source, arguments_)
        : null
    : null;
  const stdout =
    formatted === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes);
  return joinStreams(
    stdout,
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

function isGitExecutable(executable: string): boolean {
  const name = executable.split(/[\\/]/u).at(-1) ?? "";
  return name === "git" || name === "yadm";
}

function requestsCustomPresentation(arguments_: readonly string[]): boolean {
  return arguments_.some(
    (argument) =>
      argument === "--oneline" ||
      argument === "--date" ||
      argument.startsWith("--date=") ||
      argument === "--encoding" ||
      argument.startsWith("--encoding=") ||
      argument.startsWith("--format") ||
      argument.startsWith("--pretty"),
  );
}
