/**
 * The JSON representation of a runtime event, and its Zod 4 schema.
 *
 * The wire object is flat and its keys are written in a fixed order, so two
 * producers encoding the same event produce identical bytes. Branded types
 * erase to their primitives at runtime, so the wire object mirrors the domain
 * envelope exactly rather than introducing a second vocabulary.
 */

import { z } from "zod";

import {
  brandedInteger,
  brandedString,
  terminalOutcomeSchema,
  timestampSchema,
  toCodecIssues,
} from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import {
  type CapabilityInvocationStartedPayload,
  CONFIGURATION_APPLICATION_CLASSES,
  type ConfigurationGenerationChangedEvent,
  type ConfigurationGenerationChangedPayload,
  type ExecutionProfileSelectedPayload,
  isModelEvent,
  isToolEvent,
  type ModelAttemptBinding,
  type ModelAttemptStartedPayload,
  type RuntimeEvent,
  type SessionCorrelation,
  type TerminalPayload,
  type TurnCorrelation,
} from "./event.ts";
import {
  capabilityId,
  configurationGeneration,
  eventId,
  idempotencyKey,
  invocationId,
  modelAttemptId,
  modelId,
  providerId,
  sequence,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";

const schemaVersionSchema = z.int().min(1);

const sessionCorrelationSchema: z.ZodType<SessionCorrelation> = z.object({
  workspaceId: brandedString(workspaceId),
  sessionId: brandedString(sessionId),
  traceId: brandedString(traceId),
  configurationGeneration: brandedInteger(configurationGeneration),
});

const turnCorrelationSchema: z.ZodType<TurnCorrelation> = z.object({
  workspaceId: brandedString(workspaceId),
  sessionId: brandedString(sessionId),
  turnId: brandedString(turnId),
  traceId: brandedString(traceId),
  configurationGeneration: brandedInteger(configurationGeneration),
});

const emptyPayloadSchema = z.object({});

const terminalPayloadSchema: z.ZodType<TerminalPayload> = z.object({
  outcome: terminalOutcomeSchema,
});

const nullableBudgetSchema = z.number().finite().nonnegative().nullable();

const modelAttemptBindingSchema: z.ZodType<ModelAttemptBinding> = z.object({
  schemaVersion: z.literal(1),
  providerId: brandedString(providerId),
  modelId: brandedString(modelId),
  role: z.string().min(1),
  intent: z.string().min(1).nullable(),
  reasoning: z.string().min(1),
  executionProfile: z
    .object({
      id: z.enum(["ask", "plan", "debug", "agent"]),
      version: z.literal(1),
      completion: z.enum(["answer", "durable-plan", "diagnosis", "implemented-and-verified"]),
    })
    .optional(),
  providerCatalogGeneration: z.int().nonnegative(),
  toolCatalogGeneration: brandedInteger(configurationGeneration),
  policyGeneration: brandedInteger(configurationGeneration),
  runner: z.literal("product-attempt-runner.v1"),
  gateway: z.literal("product-tool-gateway.v1"),
  discoveryHandle: z.string().min(1),
  families: z.array(
    z.object({
      family: z.string().min(1),
      available: z.boolean(),
      reason: z.string().min(1).nullable(),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      capabilityId: brandedString(capabilityId),
      version: z.int().min(1),
      schemaDigest: z.string().min(1),
      schemaBytes: z.int().nonnegative(),
      schemaTokensEstimated: z.int().nonnegative(),
    }),
  ),
  omitted: z.array(
    z.object({
      name: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  schemaBytes: z.int().nonnegative(),
  schemaTokensEstimated: z.int().nonnegative(),
  budgets: z.object({
    attempts: nullableBudgetSchema,
    inputTokens: nullableBudgetSchema,
    outputTokens: nullableBudgetSchema,
    wallTimeMs: nullableBudgetSchema,
    cost: nullableBudgetSchema,
  }),
});

const modelAttemptStartedPayloadSchema: z.ZodType<ModelAttemptStartedPayload> = z.object({
  binding: modelAttemptBindingSchema.optional(),
});

const capabilityInvocationStartedPayloadSchema: z.ZodType<CapabilityInvocationStartedPayload> =
  z.object({
    capabilityVersion: z.int().min(1).optional(),
    inputDigest: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .max(128)
      .optional(),
  });

const configurationPayloadSchema: z.ZodType<ConfigurationGenerationChangedPayload> = z.object({
  generation: brandedInteger(configurationGeneration),
  applicationClass: z.literal(CONFIGURATION_APPLICATION_CLASSES),
});

const executionProfilePayloadSchema: z.ZodType<ExecutionProfileSelectedPayload> = z.object({
  selectionId: z.string().min(1).max(128),
  profileId: z.enum(["ask", "plan", "debug", "agent"]),
  profileVersion: z.literal(1),
  completion: z.enum(["answer", "durable-plan", "diagnosis", "implemented-and-verified"]),
  applicationClass: z.literal("next-turn"),
});

const envelopeSpine = {
  eventId: brandedString(eventId),
  streamId: brandedString(streamId),
  sequence: brandedInteger(sequence),
  schemaVersion: schemaVersionSchema,
  minimumReaderSchemaVersion: schemaVersionSchema,
  occurredAt: timestampSchema,
  idempotencyKey: brandedString(idempotencyKey),
};

const modelIdentity = { modelAttemptId: brandedString(modelAttemptId) };

const toolIdentity = {
  invocationId: brandedString(invocationId),
  capabilityId: brandedString(capabilityId),
};

/**
 * Unknown keys are stripped rather than rejected: a reader tolerates additive
 * optional data written by a newer producer. A newer producer that adds a
 * *required* semantic must raise `minimumReaderSchemaVersion`, which the codec
 * checks before this schema runs.
 */
const runtimeEventSchema: z.ZodType<RuntimeEvent> = z.discriminatedUnion("kind", [
  z.object({
    ...envelopeSpine,
    kind: z.literal("session.started"),
    correlation: sessionCorrelationSchema,
    payload: emptyPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("turn.started"),
    correlation: turnCorrelationSchema,
    payload: emptyPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("turn.completed"),
    correlation: turnCorrelationSchema,
    payload: terminalPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    ...modelIdentity,
    kind: z.literal("model.attempt.started"),
    correlation: turnCorrelationSchema,
    payload: modelAttemptStartedPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    ...modelIdentity,
    kind: z.literal("model.attempt.completed"),
    correlation: turnCorrelationSchema,
    payload: terminalPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    ...toolIdentity,
    kind: z.literal("capability.invocation.started"),
    correlation: turnCorrelationSchema,
    payload: capabilityInvocationStartedPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    ...toolIdentity,
    kind: z.literal("capability.invocation.completed"),
    correlation: turnCorrelationSchema,
    payload: terminalPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("configuration.generation.changed"),
    correlation: sessionCorrelationSchema,
    payload: configurationPayloadSchema,
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("execution.profile.selected"),
    correlation: sessionCorrelationSchema,
    payload: executionProfilePayloadSchema,
  }),
]);

export type WireParseResult =
  | { readonly ok: true; readonly event: RuntimeEvent }
  | { readonly ok: false; readonly issues: readonly CodecIssue[] };

/** Validates an untrusted JSON object against the closed event union. */
export function parseWireEvent(value: unknown): WireParseResult {
  const result = runtimeEventSchema.safeParse(value);
  if (result.success) {
    return { ok: true, event: result.data };
  }
  return { ok: false, issues: toCodecIssues(result.error) };
}

function correlationToJson(
  correlation: SessionCorrelation | TurnCorrelation,
): Record<string, unknown> {
  const json: Record<string, unknown> = {
    workspaceId: correlation.workspaceId,
    sessionId: correlation.sessionId,
  };
  if ("turnId" in correlation) {
    json.turnId = correlation.turnId;
  }
  json.traceId = correlation.traceId;
  json.configurationGeneration = correlation.configurationGeneration;
  return json;
}

function outcomeToJson(outcome: TerminalOutcome): Record<string, unknown> {
  return outcome.kind === "completed"
    ? { kind: outcome.kind }
    : { kind: outcome.kind, effect: outcome.effect };
}

function payloadToJson(event: RuntimeEvent): Record<string, unknown> {
  switch (event.kind) {
    case "model.attempt.started":
      return event.payload.binding === undefined ? {} : { binding: event.payload.binding };
    case "capability.invocation.started":
      return {
        ...(event.payload.capabilityVersion === undefined
          ? {}
          : { capabilityVersion: event.payload.capabilityVersion }),
        ...(event.payload.inputDigest === undefined
          ? {}
          : { inputDigest: event.payload.inputDigest }),
      };
    case "turn.completed":
    case "model.attempt.completed":
    case "capability.invocation.completed":
      return { outcome: outcomeToJson(event.payload.outcome) };
    case "configuration.generation.changed":
      return configurationPayloadToJson(event);
    case "execution.profile.selected":
      return {
        selectionId: event.payload.selectionId,
        profileId: event.payload.profileId,
        profileVersion: event.payload.profileVersion,
        completion: event.payload.completion,
        applicationClass: event.payload.applicationClass,
      };
    default:
      return {};
  }
}

function configurationPayloadToJson(
  event: ConfigurationGenerationChangedEvent,
): Record<string, unknown> {
  return {
    generation: event.payload.generation,
    applicationClass: event.payload.applicationClass,
  };
}

/**
 * Renders an event as its canonical JSON object.
 *
 * Key order is fixed by construction so equal events encode to equal bytes.
 */
export function toWireEvent(event: RuntimeEvent): Record<string, unknown> {
  const json: Record<string, unknown> = {
    eventId: event.eventId,
    streamId: event.streamId,
    sequence: event.sequence,
    kind: event.kind,
    schemaVersion: event.schemaVersion,
    minimumReaderSchemaVersion: event.minimumReaderSchemaVersion,
    occurredAt: event.occurredAt,
    idempotencyKey: event.idempotencyKey,
  };
  if (isModelEvent(event)) {
    json.modelAttemptId = event.modelAttemptId;
  }
  if (isToolEvent(event)) {
    json.invocationId = event.invocationId;
    json.capabilityId = event.capabilityId;
  }
  json.correlation = correlationToJson(event.correlation);
  json.payload = payloadToJson(event);
  return json;
}
