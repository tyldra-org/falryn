/** Reducer registry for explicit Hush command projection policies. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import { assertNever } from "../../result.ts";
import type { HushProjectionKind } from "../catalog/index.ts";
import type { HushFidelity, HushResult, HushStrategy, HushStreamProjection } from "../contracts.ts";
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
import { lsProjection } from "./ls/projection.ts";
import { searchProjection } from "./search/projection.ts";
import { semanticProjection } from "./semantic.ts";
import { structuredProjection } from "./structured/projection.ts";
import { tableProjection } from "./table/projection.ts";
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
    case "git-status":
      return gitStatusProjection(capture, maxBytes, patterns);
    case "git-diff":
      return gitDiffProjection(capture, maxBytes, patterns);
    case "git-log":
      return gitLogProjection(capture, maxBytes, patterns);
    case "git-mutation":
      return gitMutationProjection(capture, maxBytes, patterns);
    case "forge":
      return tableProjection(capture, maxBytes, patterns);
    case "test":
      return semanticProjection("test", capture, maxBytes, patterns);
    case "diagnostic":
      return semanticProjection("diagnostic", capture, maxBytes, patterns);
    case "build":
      return semanticProjection("build", capture, maxBytes, patterns);
    case "package":
      return semanticProjection("package", capture, maxBytes, patterns);
    case "table":
      return tableProjection(capture, maxBytes, patterns);
    case "log":
      return semanticProjection("log", capture, maxBytes, patterns);
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
