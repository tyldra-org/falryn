import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { CLOUD_EXECUTABLES } from "../cloud/format.ts";
import { cloudProjection } from "../cloud/projection.ts";
import { semanticProjection } from "../semantic.ts";
import { psqlProjection } from "./psql/projection.ts";
import { sqliteProjection } from "./sqlite/projection.ts";

export function structuredProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1);
  if (executable === "psql") {
    return psqlProjection(capture, maxBytes, patterns);
  }
  if (executable === "sqlite3") {
    return sqliteProjection(capture, maxBytes, patterns);
  }
  return executable !== undefined && CLOUD_EXECUTABLES.has(executable)
    ? cloudProjection(capture, maxBytes, patterns, commandTokens)
    : semanticProjection("structured", capture, maxBytes, patterns);
}
