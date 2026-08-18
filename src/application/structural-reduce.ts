/**
 * Application boundary for structural lossless reduction (#105).
 *
 * Projects files, diffs, diagnostics, and tool results through the domain
 * reducer, then redacts secret-shaped text. Redacted projections never claim
 * exact source. Does not register product tools or compact-model lanes.
 */

import { createHash } from "node:crypto";

import {
  admitEvidenceCandidate,
  CONTENT_DIGEST_ALGORITHM,
  type ContentHasherPort,
  contentDigest,
  type EvidenceAdmissionError,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  err,
  ok,
  type Result,
  reduceStructural,
  type StructuralError,
  type StructuralFamily,
  type StructuralReduceResult,
} from "../domain/index.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";

export type StructuralReduceRequest = {
  readonly family: StructuralFamily;
  readonly text: string;
  readonly sensitivity?: string;
  readonly maxBytes?: number;
  readonly keys?: readonly string[];
  readonly diagnostics?: unknown;
};

export type StructuralEvidenceRequest = {
  readonly result: StructuralReduceResult;
  readonly id: string;
  readonly workspaceId?: string;
};

export type StructuralPortError =
  | StructuralError
  | EvidenceAdmissionError
  | {
      readonly kind: "structural-port";
      readonly code: "cancelled" | "secret";
      readonly field: "signal" | "projection";
    };

export type StructuralReducer = {
  reduce(
    request: StructuralReduceRequest,
    signal?: AbortSignal,
  ): Result<StructuralReduceResult, StructuralPortError>;
};

function createSha256Hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

function applyRedaction(
  result: StructuralReduceResult,
): Result<StructuralReduceResult, StructuralPortError> {
  if (!containsRedactableSecret(result.text)) {
    return ok(result);
  }
  const text = redactText(result.text);
  if (containsRedactableSecret(text)) {
    return err({ kind: "structural-port", code: "secret", field: "projection" });
  }
  return ok({
    ...result,
    text,
    fidelity: "raw-fallback",
    evidenceFidelity: "deterministic-transform",
    claimsExact: false,
    complete: false,
    expansion: result.expansion,
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function createStructuralReducer(
  hasher: ContentHasherPort = createSha256Hasher(),
): StructuralReducer {
  return {
    reduce(request, signal) {
      if (isAborted(signal)) {
        return err({ kind: "structural-port", code: "cancelled", field: "signal" });
      }
      const reduced = reduceStructural(
        {
          family: request.family,
          text: request.text,
          ...(request.sensitivity === undefined ? {} : { sensitivity: request.sensitivity }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
          ...(request.keys === undefined ? {} : { keys: request.keys }),
          ...(request.diagnostics === undefined ? {} : { diagnostics: request.diagnostics }),
        },
        hasher,
      );
      if (!reduced.ok) {
        return reduced;
      }
      return applyRedaction(reduced.value);
    },
  };
}

export function structuralToEvidence(
  request: StructuralEvidenceRequest,
): Result<EvidenceCandidate, StructuralPortError> {
  const result = request.result;
  const base: EvidenceCandidateInput = {
    id: request.id,
    sourceKind:
      result.family === "tool" ? "tool" : result.family === "diagnostic" ? "diagnostic" : "file",
    origin: `structural:${result.family}:${result.reducerVersion}`,
    payload: { kind: "inline", text: result.text },
    estimatedTokens: Math.max(1, Math.ceil(result.reducedBytes / 4)),
    freshness: "snapshot",
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: result.claimsExact ? "exact-source" : result.evidenceFidelity,
    retrievalCost: 1,
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
  };
  if (result.claimsExact && result.expansion !== null) {
    return admitEvidenceCandidate({ ...base, exactSource: result.expansion });
  }
  return admitEvidenceCandidate({
    ...base,
    lineage: [result.reducerVersion, result.family],
    ...(result.expansion === null ? {} : { expansion: result.expansion }),
  });
}
