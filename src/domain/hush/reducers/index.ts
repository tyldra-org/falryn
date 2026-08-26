/** Reducer registry for explicit Hush command projection policies. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import { assertNever } from "../../result.ts";
import type { HushProjectionKind } from "../catalog/index.ts";
import type { HushFidelity, HushResult, HushStrategy, HushStreamProjection } from "../contracts.ts";
import { compoundProjection } from "./compound/projection.ts";
import { countProjection } from "./count/projection.ts";
import { diagnosticProjection } from "./diagnostic/projection.ts";
import { forgeProjection } from "./forge/projection.ts";
import {
  gitDiffProjection,
  gitLogProjection,
  gitMutationProjection,
  gitStatusProjection,
} from "./git/index.ts";
import { curlProjection } from "./http/curl.ts";
import { wgetProjection } from "./http/wget.ts";
import { jsonProjection } from "./json/projection.ts";
import { listingProjection } from "./listing.ts";
import { logProjection } from "./log/projection.ts";
import { lsProjection } from "./ls/projection.ts";
import { packageProjection } from "./package/projection.ts";
import { searchProjection } from "./search/projection.ts";
import { semanticProjection } from "./semantic.ts";
import { structuredProjection } from "./structured/projection.ts";
import { tableProjection } from "./table/projection.ts";
import { transformProjection } from "./transform/projection.ts";
import { treeProjection } from "./tree/projection.ts";

export function fidelityFor(
  requested: HushStrategy,
  fallback: HushResult["fallbackReason"],
  projection: HushStreamProjection,
  capture: ProcessCaptureReport,
): HushFidelity {
  if (fallback === "reducer-failure") {
    return "raw-fallback";
  }
  if (
    requested === "passthrough" &&
    projection.omissions.length === 0 &&
    !capture.stdout.truncated &&
    !capture.stderr.truncated
  ) {
    return "exact";
  }
  return "deterministic-reduction";
}

export function specializedProjection(
  projection: HushProjectionKind,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
  commandSegments: readonly (readonly string[])[],
  cwd: string | null,
): HushStreamProjection {
  switch (projection) {
    case "ls":
      return lsProjection(capture, maxBytes, patterns);
    case "tree":
      return treeProjection(capture, maxBytes, patterns, commandTokens);
    case "listing":
      return listingProjection(capture, maxBytes, patterns, commandTokens);
    case "read":
      return semanticProjection("read", capture, maxBytes, patterns);
    case "json":
      return jsonProjection(capture, maxBytes, patterns);
    case "search":
      return searchProjection(capture, maxBytes, patterns);
    case "transform":
      return transformProjection(capture, maxBytes, patterns);
    case "compound":
      return compoundProjection(capture, maxBytes, patterns, commandSegments);
    case "git-status":
      return gitStatusProjection(capture, maxBytes, patterns);
    case "git-diff":
      return gitDiffProjection(capture, maxBytes, patterns, commandTokens);
    case "git-log":
      return gitLogProjection(capture, maxBytes, patterns, commandTokens);
    case "git-mutation":
      return gitMutationProjection(capture, maxBytes, patterns, commandTokens, cwd);
    case "forge":
      return forgeProjection(capture, maxBytes, patterns, commandTokens);
    case "test":
      return semanticProjection("test", capture, maxBytes, patterns);
    case "diagnostic":
      return diagnosticProjection(capture, maxBytes, patterns, commandTokens);
    case "build":
      return semanticProjection("build", capture, maxBytes, patterns);
    case "package":
      return packageProjection(capture, maxBytes, patterns, commandTokens);
    case "table":
      return tableProjection(capture, maxBytes, patterns, commandTokens);
    case "count":
      return countProjection(capture, maxBytes, patterns, commandTokens);
    case "log":
      return logProjection(capture, maxBytes, patterns);
    case "curl":
      return curlProjection(capture, maxBytes, patterns);
    case "wget":
      return wgetProjection(capture, maxBytes, patterns, commandTokens);
    case "network":
      return semanticProjection("network", capture, maxBytes, patterns);
    case "operation":
      return semanticProjection("operation", capture, maxBytes, patterns);
    case "structured":
      return structuredProjection(capture, maxBytes, patterns, commandTokens);
    default:
      return assertNever(projection, "unhandled Hush projection");
  }
}
