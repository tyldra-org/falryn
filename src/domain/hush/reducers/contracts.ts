/** Common input and function types for Hush reducers. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import type { HushStreamProjection } from "../contracts.ts";

export type HushReduceInput = Readonly<{
  capture: ProcessCaptureReport;
  maxBytes: number;
  patterns: readonly string[];
  commandTokens: readonly string[];
  commandSegments: readonly (readonly string[])[];
  cwd: string | null;
}>;

export type HushReducer = (input: HushReduceInput) => HushStreamProjection;
