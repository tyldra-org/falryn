/** Complete textual tree projection with deterministic workspace-noise removal. */

import type { ProcessCaptureReport, ProcessStreamName } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { binaryOmission, boundStream, boundText, joinStreams } from "../stream.ts";
import { compactTreeOutput } from "./format.ts";
import { shouldPruneDefaultTreeNoise } from "./policy.ts";

export function treeProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  return joinStreams(
    projectTreeStdout("stdout", capture, maxBytes, patterns, commandTokens),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

function projectTreeStdout(
  stream: ProcessStreamName,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const stdout = capture.stdout;
  if (stdout.encoding === "binary" || stdout.inlineText === null) {
    return binaryOmission(stream, stdout);
  }
  const projected = compactTreeOutput(stdout.inlineText, {
    directoriesOnly: commandTokens.slice(1).includes("-d"),
    pruneNoise: patterns.length === 0 && shouldPruneDefaultTreeNoise(commandTokens),
  });
  return boundText(projected, stream, maxBytes);
}
