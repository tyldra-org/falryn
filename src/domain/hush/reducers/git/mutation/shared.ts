import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { binaryOmission, boundText, joinStreams, matchesPattern } from "../../stream.ts";

const GIT_PROGRESS =
  /^\s*(?:remote:\s*)?(?:(?:Enumerating|Counting|Compressing|Writing) objects?\b|Total\s+\d+\b)/iu;
const DELTA_PROGRESS = /^\s*(?:remote:\s*)?(?:Delta compression using|Resolving deltas:)/iu;

export function canSummarizeGitMutation(
  capture: ProcessCaptureReport,
  patterns: readonly string[],
): boolean {
  return (
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

export function gitMutationSummary(text: string, maxBytes: number): HushStreamProjection {
  return boundText(text, "both", maxBytes);
}

export function gitMutationFallbackProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    projectMutationStream("stdout", capture.stdout, maxBytes, patterns),
    projectMutationStream("stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}

export function gitMutationLines(capture: ProcessCaptureReport): readonly string[] {
  return [capture.stdout.inlineText ?? "", capture.stderr.inlineText ?? ""]
    .flatMap((text) => text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isGitProgress(line));
}

function projectMutationStream(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.inlineText;
  if (source === null || capture.encoding === "binary") {
    return binaryOmission(stream, capture);
  }
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  const filtered = lines.filter((line) => matchesPattern(line, patterns) || !isGitProgress(line));
  const text = `${filtered.join("\n")}${trailingNewline && filtered.length > 0 ? "\n" : ""}`;
  return boundText(text, stream, maxBytes);
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

function isGitProgress(line: string): boolean {
  return GIT_PROGRESS.test(line) || DELTA_PROGRESS.test(line);
}
