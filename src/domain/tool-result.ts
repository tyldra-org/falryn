/**
 * Typed tool results, uncertainty, diagnostics, and artifact handles (#52).
 *
 * Assembles a {@link CapabilityResult} after #51 execution. Providers, UI, and
 * agents never become the contract. Lifecycle hooks remain #53. Product
 * adapters and artifact-store ingest remain later owners — this module records
 * handles and commit facts only.
 */

import type { z } from "zod";
import type { DurationMs, Instant } from "./clock.ts";
import type { SensitiveValueRedactor } from "./configuration.ts";
import type { DiagnosticLevel } from "./diagnostics.ts";
import type { CorrelationIds, FalrynError, RecoveryAction } from "./error.ts";
import {
  MAX_CAUSE_DETAIL_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  NO_CORRELATION,
  recoveryForEffect,
} from "./error.ts";
import type {
  ArtifactId,
  CapabilityId,
  ConfigurationGeneration,
  InvocationId,
} from "./identity.ts";
import type { EffectCertainty } from "./outcome.ts";
import { assertNever } from "./result.ts";
import type { ToolInvocationOutcome } from "./tool-pipeline.ts";
import type { ProjectionContract } from "./tool-registry.ts";

/** Schema version this build writes for capability result envelopes. */
export const TOOL_RESULT_SCHEMA_VERSION = 1;

export type ArtifactRef = {
  readonly artifactId: ArtifactId;
  readonly required: boolean;
  readonly committed: boolean;
  readonly truncated: boolean;
};

export type DiagnosticRef = {
  readonly code: string;
  readonly level: DiagnosticLevel;
  readonly stage: string | null;
};

export type TimingBreakdown = {
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly queueMs: DurationMs | null;
  readonly executeMs: DurationMs | null;
  readonly captureMs: DurationMs | null;
};

export type ToolResultProvenance = {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
  readonly version: number;
  readonly catalogGeneration: ConfigurationGeneration;
};

export type ContainedProcessOutcome = {
  readonly kind: "process";
  readonly exitCode: number;
};

export type CapabilityResultStatus = ToolInvocationOutcome["status"];

export type CapabilityResult = {
  readonly schemaVersion: typeof TOOL_RESULT_SCHEMA_VERSION;
  readonly invocationId: InvocationId;
  readonly status: CapabilityResultStatus;
  readonly effect: EffectCertainty;
  readonly value: Readonly<Record<string, unknown>> | null;
  readonly error: FalrynError | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics: readonly DiagnosticRef[];
  readonly timing: TimingBreakdown;
  readonly provenance: ToolResultProvenance;
  readonly captureTruncated: boolean;
  readonly containedOutcome: ContainedProcessOutcome | null;
};

export type ModelToolResultView = {
  readonly status: CapabilityResultStatus;
  readonly effect: EffectCertainty;
  readonly value: unknown;
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly artifacts: readonly ArtifactRef[];
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
};

export type AssembleCapabilityResultInput = {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
  readonly version: number;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly outputSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  readonly maxOutputBytes: number;
  readonly outcome: ToolInvocationOutcome;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics: readonly DiagnosticRef[];
  readonly timing: TimingBreakdown;
  readonly persistFailed: boolean;
  readonly captureOverflow: boolean;
  readonly containedOutcome?: ContainedProcessOutcome;
  readonly correlation?: CorrelationIds;
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function boundMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : message;
}

function toolError(input: {
  readonly code: string;
  readonly message: string;
  readonly effect: EffectCertainty;
  readonly retryable: boolean;
  readonly exitCategory: FalrynError["exitCategory"];
  readonly correlation: CorrelationIds;
  readonly recovery?: readonly RecoveryAction[];
  readonly causeCode?: string;
}): FalrynError {
  return {
    code: input.code,
    category: "tool",
    message: boundMessage(input.message),
    retryable: input.retryable,
    effect: input.effect,
    cause:
      input.causeCode === undefined
        ? null
        : {
            source: "tool-result",
            code: input.causeCode,
            detail: boundMessage(input.causeCode).slice(0, MAX_CAUSE_DETAIL_LENGTH),
          },
    correlation: input.correlation,
    recovery: input.recovery ?? recoveryForEffect(input.effect),
    exitCategory: input.exitCategory,
    related: [],
    relatedDropped: 0,
    recognized: true,
  };
}

function effectOfOutcome(outcome: ToolInvocationOutcome): EffectCertainty {
  switch (outcome.status) {
    case "completed":
      return "completed";
    case "uncertain":
      return "uncertain";
    case "denied":
    case "unavailable":
    case "malformed":
      return "none";
    case "failed":
    case "cancelled":
    case "timed-out":
    case "partial":
      return outcome.effect;
    default:
      return assertNever(outcome, "unhandled tool outcome for result effect");
  }
}

function outputFromOutcome(
  outcome: ToolInvocationOutcome,
): Readonly<Record<string, unknown>> | null {
  switch (outcome.status) {
    case "completed":
    case "partial":
      return outcome.output;
    case "failed":
    case "cancelled":
    case "timed-out":
    case "uncertain":
    case "denied":
    case "unavailable":
    case "malformed":
      return null;
    default:
      return assertNever(outcome, "unhandled tool outcome for result output");
  }
}

function errorForOutcome(
  outcome: ToolInvocationOutcome,
  correlation: CorrelationIds,
): FalrynError | null {
  const effect = effectOfOutcome(outcome);
  switch (outcome.status) {
    case "completed":
      return null;
    case "partial":
      return toolError({
        code: "tool.partial",
        message: "tool produced a partial result",
        effect,
        retryable: false,
        exitCategory: "runtime-error",
        correlation,
      });
    case "failed":
      return toolError({
        code: "tool.failed",
        message: "tool execution failed",
        effect,
        retryable: effect === "none",
        exitCategory: "runtime-error",
        correlation,
        causeCode: outcome.reason,
      });
    case "cancelled":
      return toolError({
        code: "tool.cancelled",
        message: "tool execution was cancelled",
        effect,
        retryable: false,
        exitCategory: "cancelled",
        correlation,
      });
    case "timed-out":
      return toolError({
        code: "tool.timed-out",
        message: "tool execution timed out",
        effect,
        retryable: false,
        exitCategory: "runtime-error",
        correlation,
      });
    case "uncertain":
      return toolError({
        code: "tool.uncertain",
        message: "tool execution ended with uncertain effect",
        effect: "uncertain",
        retryable: false,
        exitCategory: "runtime-error",
        correlation,
        causeCode: outcome.recoveryHint,
      });
    case "denied":
      return toolError({
        code: "tool.denied",
        message: "tool invocation was denied",
        effect: "none",
        retryable: false,
        exitCategory: "user-error",
        correlation,
        causeCode: outcome.reason,
      });
    case "unavailable":
      return toolError({
        code: "tool.unavailable",
        message: "tool was unavailable",
        effect: "none",
        retryable: true,
        exitCategory: "runtime-error",
        correlation,
        causeCode: outcome.reason,
      });
    case "malformed":
      return toolError({
        code: "tool.malformed",
        message: "tool invocation was malformed",
        effect: "none",
        retryable: false,
        exitCategory: "user-error",
        correlation,
        causeCode: outcome.reason,
      });
    default:
      return assertNever(outcome, "unhandled tool outcome for result error");
  }
}

function requiredArtifactsMissing(artifacts: readonly ArtifactRef[]): boolean {
  return artifacts.some((artifact) => artifact.required && !artifact.committed);
}

function outputByteLength(value: Readonly<Record<string, unknown>>): number {
  return utf8Bytes(JSON.stringify(value));
}

/**
 * Assemble the canonical result envelope.
 *
 * Completed requires schema-valid output and committed required artifacts.
 * Persistence failure and schema failure never claim completion. Capture
 * overflow keeps the observed effect and records truncation.
 */
export function assembleCapabilityResult(input: AssembleCapabilityResultInput): CapabilityResult {
  const correlation = input.correlation ?? {
    ...NO_CORRELATION,
    invocationId: input.invocationId,
    capabilityId: input.capabilityId,
  };
  const provenance: ToolResultProvenance = {
    invocationId: input.invocationId,
    capabilityId: input.capabilityId,
    version: input.version,
    catalogGeneration: input.catalogGeneration,
  };
  const containedOutcome = input.containedOutcome ?? null;
  const captureTruncated =
    input.captureOverflow || input.artifacts.some((artifact) => artifact.truncated);

  const base = {
    schemaVersion: TOOL_RESULT_SCHEMA_VERSION,
    invocationId: input.invocationId,
    artifacts: input.artifacts,
    diagnostics: input.diagnostics,
    timing: input.timing,
    provenance,
    captureTruncated,
    containedOutcome,
  } as const;

  const fail = (
    status: CapabilityResultStatus,
    effect: EffectCertainty,
    error: FalrynError,
  ): CapabilityResult => ({
    ...base,
    status,
    effect,
    value: null,
    error,
  });

  if (input.persistFailed) {
    const effect = effectOfOutcome(input.outcome);
    return fail(
      "failed",
      effect === "completed" ? "uncertain" : effect,
      toolError({
        code: "tool.result-persist-failed",
        message: "tool result could not be committed",
        effect: effect === "completed" ? "uncertain" : effect,
        retryable: false,
        exitCategory: "runtime-error",
        correlation,
      }),
    );
  }

  if (input.outcome.status === "completed" || input.outcome.status === "partial") {
    const raw = outputFromOutcome(input.outcome);
    if (raw === null) {
      return fail(
        "failed",
        effectOfOutcome(input.outcome),
        toolError({
          code: "tool.output-missing",
          message: "tool claimed output but supplied none",
          effect: effectOfOutcome(input.outcome),
          retryable: false,
          exitCategory: "runtime-error",
          correlation,
        }),
      );
    }

    const parsed = input.outputSchema.safeParse(raw);
    if (!parsed.success) {
      const effect = effectOfOutcome(input.outcome);
      return fail(
        "failed",
        effect,
        toolError({
          code: "tool.output-schema",
          message: "tool output failed its result schema",
          effect,
          retryable: false,
          exitCategory: "runtime-error",
          correlation,
          causeCode: parsed.error.issues.map((issue) => issue.code).join(","),
        }),
      );
    }

    if (input.outcome.status === "completed" && requiredArtifactsMissing(input.artifacts)) {
      return fail(
        "failed",
        "completed",
        toolError({
          code: "tool.required-artifact",
          message: "required artifact was not committed",
          effect: "completed",
          retryable: false,
          exitCategory: "runtime-error",
          correlation,
        }),
      );
    }

    const overflow = outputByteLength(parsed.data) > input.maxOutputBytes || input.captureOverflow;
    return {
      ...base,
      status: input.outcome.status,
      effect: effectOfOutcome(input.outcome),
      value: parsed.data,
      error:
        input.outcome.status === "partial" ? errorForOutcome(input.outcome, correlation) : null,
      captureTruncated: overflow || base.captureTruncated,
    };
  }

  return {
    ...base,
    status: input.outcome.status,
    effect: effectOfOutcome(input.outcome),
    value: null,
    error: errorForOutcome(input.outcome, correlation),
  };
}

function redactUnknown(value: unknown, redactor: SensitiveValueRedactor): unknown {
  if (typeof value === "string") {
    return redactor.redactText(value, Number.MAX_SAFE_INTEGER);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, redactor));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = redactor.isSecretName(key) ? redactor.placeholder : redactUnknown(entry, redactor);
  }
  return out;
}

/**
 * Bounded model/UI view. Never replaces the canonical {@link CapabilityResult}.
 * Over-budget output is omitted and pointed at artifact handles instead of
 * being silently truncated mid-JSON.
 */
export function projectCapabilityResult(
  result: CapabilityResult,
  projection: ProjectionContract,
  redactor: SensitiveValueRedactor,
): ModelToolResultView {
  const prepared =
    result.value === null
      ? null
      : projection.redactSensitive
        ? redactUnknown(result.value, redactor)
        : result.value;
  const encoded = prepared === null ? "" : JSON.stringify(prepared);
  const bytes = utf8Bytes(encoded);
  const overBudget = bytes > projection.modelMaxBytes;
  return {
    status: result.status,
    effect: result.effect,
    value: overBudget ? { omitted: true, bytes } : prepared,
    truncated: overBudget || result.captureTruncated,
    omittedBytes: overBudget ? bytes : 0,
    artifacts: result.artifacts,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error === null ? null : redactor.redactText(result.error.message),
  };
}
