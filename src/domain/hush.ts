/**
 * Hush command-output reduction over exact process-capture facts.
 *
 * This stable facade owns orchestration. Public contracts, invocation parsing,
 * reducer routing, shared bounds, and reducers live under `./hush/` so adding
 * command support does not grow one central implementation file.
 */

import {
  DEFAULT_HUSH_REDUCED_BYTES,
  HUSH_REDUCER_VERSION,
  type HushError,
  type HushPort,
  type HushRequest,
  type HushResult,
  type HushStrategy,
  type HushStreamProjection,
  MAX_HUSH_REDUCED_BYTES,
} from "./hush/contracts.ts";
import type { HushReduceInput } from "./hush/reducers/contracts.ts";
import {
  genericProjection,
  passthroughProjection,
  rawFallbackProjection,
} from "./hush/reducers/fallback.ts";
import { fidelityFor } from "./hush/reducers/fidelity.ts";
import { classifyCommand, commandIdentity } from "./hush/routing/classify.ts";
import { err, ok, type Result } from "./result.ts";

export type {
  HushCommandIdentity,
  HushError,
  HushExpansion,
  HushFamily,
  HushFidelity,
  HushOmission,
  HushOmissionKind,
  HushPort,
  HushRequest,
  HushResult,
  HushStrategy,
} from "./hush/contracts.ts";
export {
  DEFAULT_HUSH_REDUCED_BYTES,
  HUSH_FAMILIES,
  HUSH_FIDELITIES,
  HUSH_REDUCER_VERSION,
  HUSH_STRATEGIES,
  MAX_HUSH_REDUCED_BYTES,
} from "./hush/contracts.ts";
export { classifyFamily, classifyReducerId } from "./hush/routing/classify.ts";

export function createHushPort(): HushPort {
  return { reduce: reduceHush };
}

export function reduceHush(request: HushRequest): Result<HushResult, HushError> {
  const invalid = validateHushRequest(request);
  if (invalid !== null) {
    return err({ kind: "hush", code: "invalid-request", reason: invalid });
  }
  const maxBytes = request.maxReducedBytes ?? DEFAULT_HUSH_REDUCED_BYTES;
  const command = commandIdentity(request.command);
  const classification = classifyCommand(request.command, request.capture);
  const family = classification.family;
  const reducerId = classification.reducerId;
  const requested = request.strategy ?? "specialized";
  const patterns = request.importantPatterns ?? [];
  const originalBytes =
    request.capture.stdout.inlineBytes.byteLength + request.capture.stderr.inlineBytes.byteLength;

  let strategy: HushStrategy = requested;
  let fallbackReason: HushResult["fallbackReason"] = null;
  let projection: HushStreamProjection;
  let projectionMaxBytes = maxBytes;
  let selectedReducerId = reducerId;

  if (requested === "passthrough") {
    selectedReducerId = "safe.passthrough";
    projection = passthroughProjection(request.capture, maxBytes, patterns);
  } else if (
    requested === "generic" ||
    !classification.matched ||
    (request.expectedFamilies !== undefined && !request.expectedFamilies.includes(family))
  ) {
    strategy = "generic";
    selectedReducerId = "generic";
    if (!classification.matched) {
      fallbackReason = "unknown-family";
    } else if (
      request.expectedFamilies !== undefined &&
      !request.expectedFamilies.includes(family)
    ) {
      fallbackReason = "expected-family-miss";
    }
    projection = genericProjection(request.capture, maxBytes, patterns);
  } else {
    try {
      projectionMaxBytes =
        request.maxReducedBytes === undefined ? MAX_HUSH_REDUCED_BYTES : maxBytes;
      const reducerInput: HushReduceInput = {
        capture: request.capture,
        maxBytes: projectionMaxBytes,
        patterns,
        commandTokens: classification.tokens,
        commandSegments: classification.commands,
        cwd: command.cwd,
      };
      projection = classification.reduce(reducerInput);
    } catch {
      strategy = "generic";
      selectedReducerId = "generic";
      fallbackReason = "reducer-failure";
      projection = rawFallbackProjection(request.capture, maxBytes);
    }
  }

  const reducedBytes = new TextEncoder().encode(projection.text).byteLength;
  if (strategy !== "passthrough" && reducedBytes >= originalBytes && originalBytes > 0) {
    strategy = "passthrough";
    projection = passthroughProjection(request.capture, projectionMaxBytes, patterns);
  }

  const truncated =
    request.capture.stdout.truncated ||
    request.capture.stderr.truncated ||
    projection.omissions.some((omission) => omission.kind === "capped-bytes");

  return ok({
    captureId: request.capture.captureId,
    command,
    family,
    reducerId: selectedReducerId,
    strategy,
    reducerVersion: HUSH_REDUCER_VERSION,
    fidelity: fidelityFor(
      strategy === "passthrough" ? "passthrough" : requested,
      fallbackReason,
      projection,
      request.capture,
    ),
    stop: request.capture.stop,
    exit: request.capture.exit,
    durationMs: request.capture.durationMs,
    stdoutBytes: request.capture.stdout.byteCount,
    stderrBytes: request.capture.stderr.byteCount,
    stdoutEncoding: request.capture.stdout.encoding,
    stderrEncoding: request.capture.stderr.encoding,
    truncated,
    reducedText: projection.text,
    omissions: projection.omissions,
    expansion: {
      stdoutInline: request.capture.stdout.inlineBytes.byteLength > 0,
      stderrInline: request.capture.stderr.inlineBytes.byteLength > 0,
      stdoutArtifact: request.capture.stdout.artifact?.artifactId ?? null,
      stderrArtifact: request.capture.stderr.artifact?.artifactId ?? null,
    },
    fallbackReason,
  });
}

export function validateHushRequest(request: HushRequest): HushError["reason"] | null {
  if (
    request.maxReducedBytes !== undefined &&
    (!Number.isSafeInteger(request.maxReducedBytes) ||
      request.maxReducedBytes < 0 ||
      request.maxReducedBytes > MAX_HUSH_REDUCED_BYTES)
  ) {
    return "invalid-reduced-limit";
  }
  for (const pattern of request.importantPatterns ?? []) {
    if (pattern.length === 0 || pattern.length > 256) {
      return "invalid-pattern";
    }
  }
  return null;
}
