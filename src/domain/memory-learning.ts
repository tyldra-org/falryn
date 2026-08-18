/**
 * Operational learning without converting telemetry into truth (#113).
 *
 * Observations are bounded aggregates (error class, tool/provider identity,
 * latency bucket, configuration generation, outcome). Prompts, source, and
 * transcript text are refused. Recommendations stay reviewable suggestions
 * and never mutate configuration, prompts, tools, or routing.
 */

import { timestampSchema } from "./branded-schema.ts";
import {
  type ConfigurationGeneration,
  configurationGeneration,
  type ObservationId,
  observationId,
  type RecommendationId,
  recommendationId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import type { MemoryError } from "./memory-record.ts";
import { err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export const MEMORY_LEARNING_VERSION = "memory-learn.v1";
export const MAX_OBSERVATION_IDENTITY_BYTES = 128;
export const MAX_RECOMMENDATION_TEXT_BYTES = 512;
export const MAX_LEARNING_SUPPORTING = 16;
export const MAX_LEARNING_COUNTEREXAMPLES = 16;
export const MAX_OBSERVATION_SAMPLES = 10_000;

export const OBSERVATION_CLASSES = [
  "error-class",
  "tool",
  "provider",
  "latency",
  "configuration",
  "outcome",
] as const;
export type ObservationClass = (typeof OBSERVATION_CLASSES)[number];

export const OBSERVATION_OUTCOMES = [
  "success",
  "failure",
  "timeout",
  "cancelled",
  "partial",
] as const;
export type ObservationOutcome = (typeof OBSERVATION_OUTCOMES)[number];

export const LATENCY_BUCKETS = ["0-50ms", "50-200ms", "200-1000ms", "1-5s", "5s+"] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

const REFUSED_TELEMETRY_KEYS = [
  "prompt",
  "source",
  "transcript",
  "messages",
  "content",
  "text",
] as const;

export type OperationalObservation = {
  readonly schemaVersion: typeof MEMORY_LEARNING_VERSION;
  readonly observationId: ObservationId;
  readonly class: ObservationClass;
  readonly identity: string;
  readonly outcome: ObservationOutcome;
  readonly sampleCount: number;
  readonly latencyBucket: LatencyBucket | null;
  readonly configurationGeneration: ConfigurationGeneration | null;
  readonly workspaceId: WorkspaceId | null;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp | null;
};

export type OperationalRecommendation = {
  readonly schemaVersion: typeof MEMORY_LEARNING_VERSION;
  readonly recommendationId: RecommendationId;
  readonly supporting: readonly ObservationId[];
  readonly counterexamples: readonly ObservationId[];
  readonly expectedBenefit: string;
  readonly risks: string;
  readonly workspaceId: WorkspaceId | null;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp | null;
  readonly status: "suggested";
};

export type OperationalObservationInput = {
  readonly observationId?: unknown;
  readonly class?: unknown;
  readonly identity?: unknown;
  readonly outcome?: unknown;
  readonly sampleCount?: unknown;
  readonly latencyBucket?: unknown;
  readonly configurationGeneration?: unknown;
  readonly workspaceId?: unknown;
  readonly createdAt?: unknown;
  readonly expiresAt?: unknown;
  readonly cancelled?: unknown;
  readonly prompt?: unknown;
  readonly source?: unknown;
  readonly transcript?: unknown;
  readonly messages?: unknown;
  readonly content?: unknown;
  readonly text?: unknown;
};

export type OperationalRecommendationInput = {
  readonly recommendationId?: unknown;
  readonly supporting?: unknown;
  readonly counterexamples?: unknown;
  readonly expectedBenefit?: unknown;
  readonly risks?: unknown;
  readonly workspaceId?: unknown;
  readonly createdAt?: unknown;
  readonly expiresAt?: unknown;
  readonly cancelled?: unknown;
  readonly prompt?: unknown;
  readonly source?: unknown;
  readonly transcript?: unknown;
  readonly messages?: unknown;
  readonly content?: unknown;
  readonly text?: unknown;
};

const encoder = new TextEncoder();

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function refuseTelemetry(input: object): Result<void, MemoryError> {
  for (const key of REFUSED_TELEMETRY_KEYS) {
    if (key in input && (input as Record<string, unknown>)[key] !== undefined) {
      return err(memoryError("denied", key));
    }
  }
  return ok(undefined);
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, MemoryError> {
  if (typeof value !== "string") {
    return err(memoryError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(memoryError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(memoryError("empty", field));
  }
  if (encoder.encode(trimmed).byteLength > maxBytes) {
    return err(memoryError("oversized", field));
  }
  return ok(trimmed);
}

function parseOptionalTimestamp(
  value: unknown,
  field: string,
): Result<Timestamp | null, MemoryError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) {
    return err(memoryError("malformed", field));
  }
  return ok(parsed.data);
}

function parseIdList(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): Result<readonly ObservationId[], MemoryError> {
  if (value === undefined) {
    return required ? err(memoryError("malformed", field)) : ok([]);
  }
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", field));
  }
  if (value.length > max) {
    return err(memoryError("oversized", field));
  }
  if (required && value.length === 0) {
    return err(memoryError("empty", field));
  }
  const ids: ObservationId[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = observationId.parse(entry);
    if (!parsed.ok) {
      return err(memoryError("malformed", `${field}.${index}`));
    }
    if (ids.includes(parsed.value)) {
      return err(memoryError("conflict", `${field}.${index}`));
    }
    ids.push(parsed.value);
  }
  return ok(ids);
}

/**
 * Validates a bounded aggregate observation. Prompts and source text fail closed.
 */
export function defineOperationalObservation(
  input: OperationalObservationInput,
): Result<OperationalObservation, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const telemetry = refuseTelemetry(input);
  if (!telemetry.ok) {
    return telemetry;
  }
  const id = observationId.parse(input.observationId);
  if (!id.ok) {
    return err(memoryError("malformed", "observationId"));
  }
  if (!OBSERVATION_CLASSES.includes(input.class as ObservationClass)) {
    return err(memoryError("malformed", "class"));
  }
  const identity = parseBoundedText(input.identity, "identity", MAX_OBSERVATION_IDENTITY_BYTES);
  if (!identity.ok) {
    return identity;
  }
  if (!OBSERVATION_OUTCOMES.includes(input.outcome as ObservationOutcome)) {
    return err(memoryError("malformed", "outcome"));
  }
  if (
    typeof input.sampleCount !== "number" ||
    !Number.isSafeInteger(input.sampleCount) ||
    input.sampleCount < 1
  ) {
    return err(memoryError("malformed", "sampleCount"));
  }
  if (input.sampleCount > MAX_OBSERVATION_SAMPLES) {
    return err(memoryError("oversized", "sampleCount"));
  }
  let latencyBucket: LatencyBucket | null = null;
  if (input.latencyBucket !== undefined && input.latencyBucket !== null) {
    if (!LATENCY_BUCKETS.includes(input.latencyBucket as LatencyBucket)) {
      return err(memoryError("malformed", "latencyBucket"));
    }
    latencyBucket = input.latencyBucket as LatencyBucket;
  }
  let generation: ConfigurationGeneration | null = null;
  if (input.configurationGeneration !== undefined && input.configurationGeneration !== null) {
    const parsed = configurationGeneration.parse(input.configurationGeneration);
    if (!parsed.ok) {
      return err(memoryError("malformed", "configurationGeneration"));
    }
    generation = parsed.value;
  }
  let workspace: WorkspaceId | null = null;
  if (input.workspaceId !== undefined && input.workspaceId !== null) {
    const parsed = workspaceId.parse(input.workspaceId);
    if (!parsed.ok) {
      return err(memoryError("malformed", "workspaceId"));
    }
    workspace = parsed.value;
  }
  const createdAt = timestampSchema.safeParse(input.createdAt);
  if (!createdAt.success) {
    return err(memoryError("malformed", "createdAt"));
  }
  const expiresAt = parseOptionalTimestamp(input.expiresAt, "expiresAt");
  if (!expiresAt.ok) {
    return expiresAt;
  }
  if (
    expiresAt.value !== null &&
    timestampToEpochMilliseconds(expiresAt.value) < timestampToEpochMilliseconds(createdAt.data)
  ) {
    return err(memoryError("stale", "expiresAt"));
  }
  return ok({
    schemaVersion: MEMORY_LEARNING_VERSION,
    observationId: id.value,
    class: input.class as ObservationClass,
    identity: identity.value,
    outcome: input.outcome as ObservationOutcome,
    sampleCount: input.sampleCount,
    latencyBucket,
    configurationGeneration: generation,
    workspaceId: workspace,
    createdAt: createdAt.data,
    expiresAt: expiresAt.value,
  });
}

/**
 * Validates a reviewable recommendation. It cannot be marked applied.
 */
export function defineOperationalRecommendation(
  input: OperationalRecommendationInput,
): Result<OperationalRecommendation, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const telemetry = refuseTelemetry(input);
  if (!telemetry.ok) {
    return telemetry;
  }
  const id = recommendationId.parse(input.recommendationId);
  if (!id.ok) {
    return err(memoryError("malformed", "recommendationId"));
  }
  const supporting = parseIdList(input.supporting, "supporting", MAX_LEARNING_SUPPORTING, true);
  if (!supporting.ok) {
    return supporting;
  }
  const counterexamples = parseIdList(
    input.counterexamples,
    "counterexamples",
    MAX_LEARNING_COUNTEREXAMPLES,
    false,
  );
  if (!counterexamples.ok) {
    return counterexamples;
  }
  for (const counter of counterexamples.value) {
    if (supporting.value.includes(counter)) {
      return err(memoryError("conflict", "counterexamples"));
    }
  }
  const expectedBenefit = parseBoundedText(
    input.expectedBenefit,
    "expectedBenefit",
    MAX_RECOMMENDATION_TEXT_BYTES,
  );
  if (!expectedBenefit.ok) {
    return expectedBenefit;
  }
  const risks = parseBoundedText(input.risks, "risks", MAX_RECOMMENDATION_TEXT_BYTES);
  if (!risks.ok) {
    return risks;
  }
  let workspace: WorkspaceId | null = null;
  if (input.workspaceId !== undefined && input.workspaceId !== null) {
    const parsed = workspaceId.parse(input.workspaceId);
    if (!parsed.ok) {
      return err(memoryError("malformed", "workspaceId"));
    }
    workspace = parsed.value;
  }
  const createdAt = timestampSchema.safeParse(input.createdAt);
  if (!createdAt.success) {
    return err(memoryError("malformed", "createdAt"));
  }
  const expiresAt = parseOptionalTimestamp(input.expiresAt, "expiresAt");
  if (!expiresAt.ok) {
    return expiresAt;
  }
  if (
    expiresAt.value !== null &&
    timestampToEpochMilliseconds(expiresAt.value) < timestampToEpochMilliseconds(createdAt.data)
  ) {
    return err(memoryError("stale", "expiresAt"));
  }
  return ok({
    schemaVersion: MEMORY_LEARNING_VERSION,
    recommendationId: id.value,
    supporting: supporting.value,
    counterexamples: counterexamples.value,
    expectedBenefit: expectedBenefit.value,
    risks: risks.value,
    workspaceId: workspace,
    createdAt: createdAt.data,
    expiresAt: expiresAt.value,
    status: "suggested",
  });
}
