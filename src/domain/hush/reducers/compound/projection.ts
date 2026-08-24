import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { losslessTextProjection } from "../lossless-text.ts";

const SEARCH_EXECUTABLES = new Set(["ag", "grep", "rg", "ripgrep"]);

export function compoundProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commands: readonly (readonly string[])[],
): HushStreamProjection {
  const searchAware = commands.some((tokens) => SEARCH_EXECUTABLES.has(tokens[0] ?? ""));
  return losslessTextProjection(capture, maxBytes, patterns, searchAware);
}
