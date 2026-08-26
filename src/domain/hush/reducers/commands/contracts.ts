/** Contracts shared by catalog-owned Hush command reducers. */

import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";

export type HushReducerContext = Readonly<{
  capture: ProcessCaptureReport;
  maxBytes: number;
  patterns: readonly string[];
  commandTokens: readonly string[];
  commandSegments: readonly (readonly string[])[];
  cwd: string | null;
}>;

export type HushCommandReducer = (context: HushReducerContext) => HushStreamProjection;
