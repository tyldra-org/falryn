import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";

export const reduceGitStatus: HushReducer = ({ capture, maxBytes, patterns }) =>
  gitStatusProjection(capture, maxBytes, patterns);

export function gitStatusProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const compact =
    source !== null && patterns.length === 0 && source.startsWith("## ")
      ? `* ${source.slice(3)}`
      : null;
  return joinStreams(
    compact === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(compact, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}
