/**
 * Application boundary for optional compact-model and history checkpoint
 * lanes (#106).
 *
 * Redacts secret-shaped projections and never lets a redacted compact-model
 * result claim exact source. Does not register product tools or run fidelity
 * eval (#107).
 */

import { createHash } from "node:crypto";

import {
  admitEvidenceCandidate,
  CONTENT_DIGEST_ALGORITHM,
  type CompactError,
  type CompactModelPort,
  type CompactReduceResult,
  type ContentHasherPort,
  checkpointHistory,
  contentDigest,
  type EvidenceAdmissionError,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  err,
  type HistoryCheckpoint,
  ok,
  previewCompactForSmallerWindow,
  type Result,
  reduceCompact,
  retryAfterOverflow,
} from "../domain/index.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";

export type CompactLaneRequest = {
  readonly text: string;
  readonly question?: string;
  readonly sensitivity?: string;
  readonly maxBytes?: number;
  readonly compactUse?: "evaluated" | "off";
};

export type HistoryLaneRequest = {
  readonly checkpointId: string;
  readonly items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly retained?: boolean;
  }[];
  readonly compactUse?: "evaluated" | "off";
  readonly maxBytes?: number;
};

export type OverflowLaneRequest = HistoryLaneRequest & {
  readonly consecutiveOverflows: number;
  readonly reason: string;
};

export type WindowPreviewRequest = HistoryLaneRequest & {
  readonly fromWindowTokens: number;
  readonly toWindowTokens: number;
};

export type CompactLaneError =
  | CompactError
  | EvidenceAdmissionError
  | {
      readonly kind: "compact-port";
      readonly code: "cancelled" | "secret";
      readonly field: "signal" | "projection";
    };

export type CompactLanes = {
  reduce(
    request: CompactLaneRequest,
    signal?: AbortSignal,
  ): Result<CompactReduceResult, CompactLaneError>;
  checkpoint(
    request: HistoryLaneRequest,
    signal?: AbortSignal,
  ): Result<HistoryCheckpoint, CompactLaneError>;
  retryOverflow(
    request: OverflowLaneRequest,
    signal?: AbortSignal,
  ): Result<
    {
      readonly action: "retry";
      readonly overflowRetries: 1;
      readonly checkpoint: HistoryCheckpoint;
    },
    CompactLaneError
  >;
  previewSmallerWindow(
    request: WindowPreviewRequest,
    signal?: AbortSignal,
  ): Result<HistoryCheckpoint, CompactLaneError>;
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

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function redactCompact(result: CompactReduceResult): Result<CompactReduceResult, CompactLaneError> {
  if (!containsRedactableSecret(result.text)) {
    return ok(result);
  }
  const text = redactText(result.text);
  if (containsRedactableSecret(text)) {
    return err({ kind: "compact-port", code: "secret", field: "projection" });
  }
  return ok({
    ...result,
    text,
    selectedStrategy: "passthrough",
    fallbackDestination: "passthrough",
    fallbackReason: result.fallbackReason ?? "malformed",
    evidenceFidelity: "deterministic-transform",
    claimsExact: false,
    complete: false,
  });
}

function redactCheckpoint(
  checkpoint: HistoryCheckpoint,
): Result<HistoryCheckpoint, CompactLaneError> {
  const preserved = checkpoint.preserved.map((item) => {
    if (!containsRedactableSecret(item.text)) {
      return item;
    }
    return { ...item, text: redactText(item.text) };
  });
  if (preserved.some((item) => containsRedactableSecret(item.text))) {
    return err({ kind: "compact-port", code: "secret", field: "projection" });
  }
  if (checkpoint.folded === null) {
    return ok({ ...checkpoint, preserved });
  }
  const folded = redactCompact(checkpoint.folded);
  if (!folded.ok) {
    return folded;
  }
  return ok({ ...checkpoint, preserved, folded: folded.value });
}

export function createCompactLanes(
  port: CompactModelPort | null = null,
  hasher: ContentHasherPort = createSha256Hasher(),
): CompactLanes {
  return {
    reduce(request, signal) {
      if (isAborted(signal)) {
        return err({ kind: "compact-port", code: "cancelled", field: "signal" });
      }
      const reduced = reduceCompact(
        {
          text: request.text,
          ...(request.question === undefined ? {} : { question: request.question }),
          ...(request.sensitivity === undefined ? {} : { sensitivity: request.sensitivity }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
          ...(request.compactUse === undefined ? {} : { compactUse: request.compactUse }),
        },
        hasher,
        port,
      );
      if (!reduced.ok) {
        return reduced;
      }
      return redactCompact(reduced.value);
    },
    checkpoint(request, signal) {
      if (isAborted(signal)) {
        return err({ kind: "compact-port", code: "cancelled", field: "signal" });
      }
      const checkpoint = checkpointHistory(
        {
          checkpointId: request.checkpointId,
          items: request.items,
          ...(request.compactUse === undefined ? {} : { compactUse: request.compactUse }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        hasher,
        port,
      );
      if (!checkpoint.ok) {
        return checkpoint;
      }
      return redactCheckpoint(checkpoint.value);
    },
    retryOverflow(request, signal) {
      if (isAborted(signal)) {
        return err({ kind: "compact-port", code: "cancelled", field: "signal" });
      }
      const retried = retryAfterOverflow(
        {
          checkpointId: request.checkpointId,
          items: request.items,
          consecutiveOverflows: request.consecutiveOverflows,
          reason: request.reason,
          ...(request.compactUse === undefined ? {} : { compactUse: request.compactUse }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        hasher,
        port,
      );
      if (!retried.ok) {
        return retried;
      }
      const checkpoint = redactCheckpoint(retried.value.checkpoint);
      if (!checkpoint.ok) {
        return checkpoint;
      }
      return ok({
        action: "retry" as const,
        overflowRetries: 1 as const,
        checkpoint: checkpoint.value,
      });
    },
    previewSmallerWindow(request, signal) {
      if (isAborted(signal)) {
        return err({ kind: "compact-port", code: "cancelled", field: "signal" });
      }
      const preview = previewCompactForSmallerWindow(
        {
          checkpointId: request.checkpointId,
          items: request.items,
          fromWindowTokens: request.fromWindowTokens,
          toWindowTokens: request.toWindowTokens,
          ...(request.compactUse === undefined ? {} : { compactUse: request.compactUse }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        hasher,
        port,
      );
      if (!preview.ok) {
        return preview;
      }
      return redactCheckpoint(preview.value);
    },
  };
}

export function compactToEvidence(request: {
  readonly result: CompactReduceResult;
  readonly id: string;
  readonly workspaceId?: string;
}): Result<EvidenceCandidate, CompactLaneError> {
  const result = request.result;
  const base: EvidenceCandidateInput = {
    id: request.id,
    sourceKind: "conversation",
    origin: `compact:${result.strategyVersion}:${result.selectedStrategy}`,
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
    lineage: [result.strategyVersion, result.selectedStrategy],
    ...(result.expansion === null ? {} : { expansion: result.expansion }),
  });
}
