/** Information-preserving `ls` projection with no command-specific sampling cap. */

import type { ProcessCaptureReport, ProcessStreamName } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { binaryOmission, boundStream, boundText, joinStreams } from "../stream.ts";
import { compactInodeBlockLs } from "./block-format.ts";
import { compactLongLs } from "./long-format.ts";

export const reduceLs: HushReducer = ({ capture, maxBytes, patterns }) =>
  lsProjection(capture, maxBytes, patterns);

export function lsProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    projectLsStdout("stdout", capture, maxBytes, patterns),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

function projectLsStdout(
  stream: ProcessStreamName,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const stdout = capture.stdout;
  if (stdout.encoding === "binary" || stdout.inlineText === null) {
    return binaryOmission(stream, stdout);
  }
  const projected =
    patterns.length > 0
      ? stdout.inlineText
      : (compactLongLs(stdout.inlineText) ??
        compactInodeBlockLs(stdout.inlineText) ??
        stdout.inlineText);
  return boundText(projected, stream, maxBytes);
}
