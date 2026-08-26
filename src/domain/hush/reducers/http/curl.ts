import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import {
  compactDuplicateRuns,
  compactJsonWhitespace,
  shortestText,
  stripAnsi,
} from "../shared/text.ts";
import { binaryOmission, boundText, joinStreams } from "../stream.ts";
import { stripCurlProgress } from "./progress.ts";
import { formatCurlResponse } from "./response.ts";

export function curlProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    projectCurlStream("stdout", capture.stdout, maxBytes, patterns),
    projectCurlStream("stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}

function projectCurlStream(
  stream: "stdout" | "stderr",
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const plain = stripAnsi(capture.inlineText);
  const withoutProgress = stream === "stderr" ? stripCurlProgress(plain, patterns) : plain;
  const duplicateCompaction = compactDuplicateRuns(withoutProgress);
  const jsonCompaction = compactJsonWhitespace(withoutProgress);
  const responseCompaction = stream === "stdout" ? formatCurlResponse(withoutProgress) : null;
  const projected = shortestText(
    plain,
    withoutProgress,
    duplicateCompaction,
    ...(jsonCompaction === null ? [] : [jsonCompaction]),
    ...(responseCompaction === null ? [] : [responseCompaction]),
  );
  return boundText(projected, stream, maxBytes);
}
