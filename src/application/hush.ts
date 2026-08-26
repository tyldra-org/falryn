/**
 * Application boundary for Hush observation (#103).
 *
 * Captures or accepts finished process facts, then projects a bounded Hush
 * view for shell, Git, test, search, and generic process origins. Terminal
 * facts stay on the capture report. The projection is redacted for model and
 * evidence use and is never admitted as exact source when it is a reduction.
 * For maintained read commands, the capture request may be refined to obtain
 * structured facts while the original command remains the Hush identity. Does
 * not spawn except through the injected capture port, and does not register
 * product tools or Loom manifests.
 */

import { z } from "zod";

import {
  admitEvidenceCandidate,
  assertNever,
  type CommandRequest,
  createHushPort,
  type EvidenceAdmissionError,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  type ExactSourceHandleInput,
  err,
  type HushError,
  type HushFamily,
  type HushPort,
  type HushRequest,
  type HushResult,
  type HushStrategy,
  ok,
  type ProcessCaptureError,
  type ProcessCaptureListener,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  type Result,
} from "../domain/index.ts";
import { digestBytes } from "./composer-context.ts";
import { prepareHushCaptureRequest } from "./hush-capture-command.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";

export const HUSH_ORIGINS = ["shell", "git", "test", "search", "process"] as const;
export type HushOrigin = (typeof HUSH_ORIGINS)[number];

const hushOriginSchema = z.enum(HUSH_ORIGINS);

export type HushObservation = {
  readonly origin: HushOrigin;
  readonly capture: ProcessCaptureReport;
  readonly hush: HushResult;
  readonly projection: string;
};

export type HushObserveRequest = {
  readonly origin: unknown;
  readonly command: ProcessCaptureRequest;
  readonly strategy?: HushStrategy;
  readonly maxReducedBytes?: number;
  readonly importantPatterns?: readonly string[];
  readonly expectedFamilies?: readonly HushFamily[];
};

export type HushReduceRequest = {
  readonly origin: unknown;
  readonly command: CommandRequest;
  readonly capture: ProcessCaptureReport;
  readonly strategy?: HushStrategy;
  readonly maxReducedBytes?: number;
  readonly importantPatterns?: readonly string[];
  readonly expectedFamilies?: readonly HushFamily[];
};

export type HushEvidenceRequest = {
  readonly observation: HushObservation;
  readonly id: string;
  readonly workspaceId?: string;
  readonly scopeId?: string;
};

export type HushObservationError =
  | HushError
  | ProcessCaptureError
  | EvidenceAdmissionError
  | {
      readonly kind: "hush-observation";
      readonly code: "invalid-origin" | "unavailable" | "empty" | "secret";
      readonly field: "origin" | "capture" | "payload" | "projection";
    };

export type HushIntegrator = {
  observe(
    request: HushObserveRequest,
    listener?: ProcessCaptureListener,
  ): Promise<Result<HushObservation, HushObservationError>>;
  reduce(request: HushReduceRequest): Result<HushObservation, HushObservationError>;
  toEvidence(request: HushEvidenceRequest): Result<EvidenceCandidate, HushObservationError>;
};

export type HushIntegratorOptions = {
  readonly capture?: ProcessCapturePort;
  readonly hush?: HushPort;
};

export function expectedFamiliesForOrigin(origin: HushOrigin): readonly HushFamily[] | undefined {
  switch (origin) {
    case "shell":
      return ["listing", "search", "generic"];
    case "git":
      return ["git"];
    case "test":
      return ["test", "lint", "typecheck", "build"];
    case "search":
      return ["search"];
    case "process":
      return undefined;
    default:
      return assertNever(origin, "unhandled hush origin");
  }
}

export function createHushIntegrator(options: HushIntegratorOptions = {}): HushIntegrator {
  const hush = options.hush ?? createHushPort();
  const capture = options.capture;

  const reduce = (request: HushReduceRequest): Result<HushObservation, HushObservationError> => {
    const origin = parseOrigin(request.origin);
    if (!origin.ok) {
      return origin;
    }
    const hushRequest = buildHushRequest(origin.value, request);
    const reduced = hush.reduce(hushRequest);
    if (!reduced.ok) {
      return reduced;
    }
    return ok(observationFrom(origin.value, request.capture, reduced.value));
  };

  return {
    async observe(request, listener) {
      const origin = parseOrigin(request.origin);
      if (!origin.ok) {
        return origin;
      }
      if (capture === undefined) {
        return err({
          kind: "hush-observation",
          code: "unavailable",
          field: "capture",
        });
      }
      const captured = await capture.run(prepareHushCaptureRequest(request.command), listener);
      if (!captured.ok) {
        return captured;
      }
      return reduce({
        origin: origin.value,
        command: request.command,
        capture: captured.value,
        ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
        ...(request.maxReducedBytes === undefined
          ? {}
          : { maxReducedBytes: request.maxReducedBytes }),
        ...(request.importantPatterns === undefined
          ? {}
          : { importantPatterns: request.importantPatterns }),
        ...(request.expectedFamilies === undefined
          ? {}
          : { expectedFamilies: request.expectedFamilies }),
      });
    },
    reduce,
    toEvidence(request) {
      return admitObservation(request);
    },
  };
}

function parseOrigin(value: unknown): Result<HushOrigin, HushObservationError> {
  const parsed = hushOriginSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      kind: "hush-observation",
      code: "invalid-origin",
      field: "origin",
    });
  }
  return ok(parsed.data);
}

function buildHushRequest(origin: HushOrigin, request: HushReduceRequest): HushRequest {
  const expected =
    request.expectedFamilies === undefined
      ? expectedFamiliesForOrigin(origin)
      : request.expectedFamilies;
  return {
    command: request.command,
    capture: request.capture,
    ...(expected === undefined ? {} : { expectedFamilies: expected }),
    ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
    ...(request.maxReducedBytes === undefined ? {} : { maxReducedBytes: request.maxReducedBytes }),
    ...(request.importantPatterns === undefined
      ? {}
      : { importantPatterns: request.importantPatterns }),
  };
}

function observationFrom(
  origin: HushOrigin,
  capture: ProcessCaptureReport,
  hush: HushResult,
): HushObservation {
  const projection = redactProjection(hush.reducedText);
  return {
    origin,
    capture,
    hush,
    projection,
  };
}

function redactProjection(text: string): string {
  if (!containsRedactableSecret(text)) {
    return text;
  }
  return redactText(text);
}

function admitObservation(
  request: HushEvidenceRequest,
): Result<EvidenceCandidate, HushObservationError> {
  const { observation } = request;
  if (observation.projection.length === 0) {
    return err({
      kind: "hush-observation",
      code: "empty",
      field: "payload",
    });
  }
  if (containsRedactableSecret(observation.projection)) {
    return err({
      kind: "hush-observation",
      code: "secret",
      field: "projection",
    });
  }

  const bytes = new TextEncoder().encode(observation.projection);
  const redacted = observation.projection !== observation.hush.reducedText;
  const exact =
    observation.hush.fidelity === "exact" &&
    !redacted &&
    observation.hush.omissions.length === 0 &&
    !observation.capture.stdout.truncated &&
    !observation.capture.stderr.truncated;

  const base: Omit<
    EvidenceCandidateInput,
    "fidelity" | "lineage" | "exactSource" | "expansion" | "relationships" | "retrievalCost"
  > = {
    id: request.id,
    sourceKind: "process",
    origin: evidenceOrigin(observation),
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.scopeId === undefined ? {} : { scopeId: request.scopeId }),
    payload: { kind: "inline", text: observation.projection },
    estimatedTokens: Math.max(1, Math.ceil(bytes.byteLength / 4)),
    freshness: "snapshot",
    sensitivity: redacted ? "sensitive" : "user-content",
    trust: "adapter-declared",
  };

  if (exact) {
    return admitEvidenceCandidate({
      ...base,
      fidelity: "exact-source",
      exactSource: {
        kind: "inline",
        digest: digestBytes(bytes),
        byteLength: bytes.byteLength,
      },
    });
  }

  const expansion = expansionFromCapture(observation.capture);
  return admitEvidenceCandidate({
    ...base,
    fidelity: "deterministic-transform",
    lineage: [observation.hush.reducerVersion, observation.hush.reducerId],
    ...(expansion === null ? {} : { expansion }),
  });
}

function evidenceOrigin(observation: HushObservation): string {
  return `hush:${observation.origin}:${observation.hush.family}:${observation.hush.reducerId}`;
}

function expansionFromCapture(capture: ProcessCaptureReport): ExactSourceHandleInput | null {
  const stdout = capture.stdout.inlineBytes;
  const stderr = capture.stderr.inlineBytes;
  const bytes = stdout.byteLength > 0 ? stdout : stderr;
  if (bytes.byteLength === 0) {
    return null;
  }
  return {
    kind: "inline",
    digest: digestBytes(bytes),
    byteLength: bytes.byteLength,
  };
}
