/** Exact, generic, and reducer-failure fallback projections. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import type { HushStreamProjection } from "../contracts.ts";
import { boundStream, joinStreams } from "./stream.ts";

export function passthroughProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, false),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

export function genericProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, true),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

export function rawFallbackProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
): HushStreamProjection {
  const fallback = passthroughProjection(capture, maxBytes, []);
  return {
    text: fallback.text,
    omissions: [
      ...fallback.omissions,
      { kind: "reducer-failure", stream: "both", count: 1, detail: null },
    ],
  };
}
