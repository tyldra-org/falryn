import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { binaryOmission, boundStream, boundText, joinStreams } from "../stream.ts";
import { formatJsonStructure } from "./format.ts";

export const reduceJson: HushReducer = ({ capture, maxBytes, patterns }) =>
  jsonProjection(capture, maxBytes, patterns);

export function jsonProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const structure =
    capture.stdout.encoding === "utf-8" && source !== null ? formatJsonStructure(source) : null;
  const stdout =
    capture.stdout.encoding === "binary" || source === null
      ? binaryOmission("stdout", capture.stdout)
      : structure === null
        ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
        : boundText(structure, "stdout", maxBytes);
  return joinStreams(
    stdout,
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}
