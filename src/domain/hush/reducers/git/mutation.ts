import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../../process-capture.ts";
import { binaryOmission, boundText, joinStreams, matchesPattern } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";

const GIT_PROGRESS = /^\s*(?:Enumerating|Counting|Compressing|Writing|Total) objects?\b/iu;

export function gitMutationProjection(
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
  const filtered = lines.filter(
    (line) => matchesPattern(line, patterns) || !GIT_PROGRESS.test(line),
  );
  const text = `${filtered.join("\n")}${trailingNewline ? "\n" : ""}`;
  return boundText(text, stream, maxBytes);
}
