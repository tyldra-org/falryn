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
import {
  CAPABILITY_EFFECTIVE_HEALTH_STATES,
  CAPABILITY_HEALTH_CODES,
} from "./capability-health.ts";
import { CAPABILITY_CONTRIBUTION_KINDS, CAPABILITY_SOURCES } from "./capability-registry.ts";
import type { CodecIssue } from "./codec-error.ts";
import {
  type CapabilityInvocationCompletedPayload,
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
import {
  AUTOMATION_OPPORTUNITY_KINDS,
  CAPABILITY_DEGRADATION_SCHEMA_VERSION,
  CAPABILITY_DEGRADATION_TRIGGERS,
  CAPABILITY_UNAVAILABLE_REASONS,
  MAX_CAPABILITY_DEGRADATION_TRANSITIONS,
  MAX_CAPABILITY_FALLBACKS_PER_SOURCE,
  MAX_CAPABILITY_RUNTIME_FALLBACK_TRANSITIONS,
  MAX_OPPORTUNITY_REASON_CODES,
  MAX_OPPORTUNITY_REJECTIONS,
  MAX_OPPORTUNITY_SCHEMA_TOKEN_BUDGET,
  MAX_OPPORTUNITY_SELECTION_LIMIT,
  type ModelCapabilityBrief,
  OPPORTUNITY_DECISIONS,
  OPPORTUNITY_PLAN_SCHEMA_VERSION,
  OPPORTUNITY_REASON_CODES,
  OPPORTUNITY_SIGNAL_FAMILIES,
} from "./opportunity-plan.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { EFFECT_CLASSES } from "./work.ts";

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

const opportunityDecisionSchema = z
  .object({
    capabilityId: brandedString(capabilityId),
    name: z.string().min(1).max(256),
    kind: z.enum(CAPABILITY_CONTRIBUTION_KINDS),
    family: z.enum(OPPORTUNITY_SIGNAL_FAMILIES).nullable(),
    source: z.enum(CAPABILITY_SOURCES),
    effect: z.enum(EFFECT_CLASSES),
    health: z.enum(CAPABILITY_EFFECTIVE_HEALTH_STATES),
    decision: z.enum(OPPORTUNITY_DECISIONS),
    score: z.int(),
    schemaTokensEstimated: z.int().nonnegative(),
    reasons: z.array(z.enum(OPPORTUNITY_REASON_CODES)).max(MAX_OPPORTUNITY_REASON_CODES),
    diagnosticCodes: z.array(z.enum(CAPABILITY_HEALTH_CODES)).max(CAPABILITY_HEALTH_CODES.length),
    recoveryHandles: z.array(z.string().min(1).max(512)).max(MAX_OPPORTUNITY_REASON_CODES),
  })
  .strict();

const modelCapabilityBriefSchema: z.ZodType<ModelCapabilityBrief> = z
  .object({
    schemaVersion: z.literal(OPPORTUNITY_PLAN_SCHEMA_VERSION),
    planId: z.string().min(1).max(256),
    taskFingerprint: z.string().regex(/^[a-f0-9]{24}$/u),
    catalogGeneration: brandedInteger(configurationGeneration),
    policyGeneration: brandedInteger(configurationGeneration),
    profileId: z.enum(["ask", "plan", "debug", "agent"]),
    signalledFamilies: z
      .array(z.enum(OPPORTUNITY_SIGNAL_FAMILIES))
      .max(OPPORTUNITY_SIGNAL_FAMILIES.length),
    requiredFamilies: z.array(z.string().min(1).max(64)).max(OPPORTUNITY_SIGNAL_FAMILIES.length),
    primaryFamily: z.enum(OPPORTUNITY_SIGNAL_FAMILIES),
    fallbackFamilies: z
      .array(z.enum(OPPORTUNITY_SIGNAL_FAMILIES))
      .max(OPPORTUNITY_SIGNAL_FAMILIES.length),
    selected: z.array(opportunityDecisionSchema).max(MAX_OPPORTUNITY_SELECTION_LIMIT),
    fallbacks: z.array(opportunityDecisionSchema).max(MAX_OPPORTUNITY_REJECTIONS),
    rejected: z.array(opportunityDecisionSchema).max(MAX_OPPORTUNITY_REJECTIONS),
    omittedRejected: z.int().nonnegative(),
    opportunities: z
      .array(
        z
          .object({
            kind: z.enum(AUTOMATION_OPPORTUNITY_KINDS),
            decision: z.enum(["selected", "recommended", "unavailable", "not-needed", "deferred"]),
            capabilityIds: z
              .array(brandedString(capabilityId))
              .max(MAX_OPPORTUNITY_SELECTION_LIMIT),
            reason: z.enum(OPPORTUNITY_REASON_CODES),
          })
          .strict(),
      )
      .max(AUTOMATION_OPPORTUNITY_KINDS.length),
    modelAssistance: z
      .object({
        decision: z.enum(["not-needed", "eligible"]),
        candidateIds: z.array(brandedString(capabilityId)).max(2),
        reason: z.enum(["deterministic-winner", "semantic-tie"]),
      })
      .strict(),
    degradation: z
      .object({
        schemaVersion: z.literal(CAPABILITY_DEGRADATION_SCHEMA_VERSION),
        catalogGeneration: brandedInteger(configurationGeneration),
        strategy: z.literal("explicit-model-continuation"),
        maxRuntimeTransitions: z.int().min(1).max(MAX_CAPABILITY_RUNTIME_FALLBACK_TRANSITIONS),
        transitions: z
          .array(
            z
              .object({
                fromCapabilityId: brandedString(capabilityId),
                toCapabilityId: brandedString(capabilityId),
                triggers: z
                  .array(z.enum(CAPABILITY_DEGRADATION_TRIGGERS))
                  .min(1)
                  .max(CAPABILITY_DEGRADATION_TRIGGERS.length),
                strategy: z.literal("model-continuation"),
                informationChange: z.literal("different-contract"),
                effectChange: z.enum(["same", "reduced"]),
                notice: z.string().min(1).max(512),
              })
              .strict(),
          )
          .max(MAX_CAPABILITY_DEGRADATION_TRANSITIONS),
        terminalOutcomes: z
          .array(
            z
              .object({
                capabilityId: brandedString(capabilityId),
                outcome: z.literal("unavailable"),
                reason: z.enum(CAPABILITY_UNAVAILABLE_REASONS),
                recoveryHandles: z
                  .array(z.string().min(1).max(512))
                  .max(MAX_OPPORTUNITY_REASON_CODES),
              })
              .strict(),
          )
          .max(MAX_CAPABILITY_DEGRADATION_TRANSITIONS),
      })
      .strict(),
    schemaTokensEstimated: z.int().nonnegative(),
    selectionLimit: z.int().min(1).max(MAX_OPPORTUNITY_SELECTION_LIMIT),
    schemaTokenBudget: z.int().nonnegative().max(MAX_OPPORTUNITY_SCHEMA_TOKEN_BUDGET),
    discoveryHandle: z.string().min(1).max(256),
  })
  .strict();

const modelAttemptBindingSchema: z.ZodType<ModelAttemptBinding> = z.object({
  schemaVersion: z.literal(1),
  providerId: brandedString(providerId),
  providerProfileId: z.string().min(1).optional(),
  providerAdapterKind: z.string().min(1).optional(),
  providerDestinationId: z.string().min(1).optional(),
  transportCompatibilityId: z.string().min(1).optional(),
  modelId: brandedString(modelId),
  role: z.string().min(1),
  intent: z.string().min(1).nullable(),
  reasoning: z.string().min(1),
  providerReasoningControl: z.string().min(1).nullable().optional(),
  executionProfile: z
    .object({
      id: z.enum(["ask", "plan", "debug", "agent"]),
      version: z.literal(1),
      completion: z.enum(["answer", "durable-plan", "diagnosis", "implemented-and-verified"]),
    })
    .optional(),
  providerCatalogGeneration: z.int().nonnegative(),
  modelCapabilitySchemaVersion: z.int().positive().optional(),
  toolCatalogGeneration: brandedInteger(configurationGeneration),
  policyGeneration: brandedInteger(configurationGeneration),
  runner: z.literal("product-attempt-runner.v1"),
  gateway: z.literal("product-tool-gateway.v1"),
  discoveryHandle: z.string().min(1),
  opportunityPlan: modelCapabilityBriefSchema.optional(),
  capabilityCatalog: z
    .object({
      total: z.int().nonnegative(),
      counts: z.record(z.string().min(1), z.int().nonnegative()),
      cards: z
        .array(
          z.object({
            capabilityId: brandedString(capabilityId),
            kind: z.string().min(1),
            family: z.string().min(1).nullable(),
            source: z.string().min(1),
            version: z.int().positive(),
            costClass: z.string().min(1),
            latencyClass: z.string().min(1),
            available: z.boolean(),
            executable: z.boolean(),
            disclosed: z.boolean(),
            health: z.string().min(1).optional(),
            selected: z.boolean().optional(),
            projected: z.boolean().optional(),
            diagnosticCodes: z.array(z.string().min(1)).max(16).optional(),
          }),
        )
        .max(256),
    })
    .optional(),
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
  promptCache: z
    .object({
      schemaVersion: z.literal(1),
      key: z.string().regex(/^sha-256:[a-f0-9]{64}$/u),
      scope: z.literal("session"),
      stablePrefixDigest: z.string().regex(/^sha-256:[a-f0-9]{64}$/u),
      stableMessageCount: z.int().nonnegative(),
      toolCatalogGeneration: z.int().nonnegative(),
      mode: z
        .enum([
          "implicit-prefix",
          "openai-routing-key",
          "anthropic-ephemeral",
          "google-explicit-resource",
          "provider-managed",
        ])
        .optional(),
      minimumInputTokens: z.int().positive().nullable().optional(),
    })
    .optional(),
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

const capabilityInvocationCompletedPayloadSchema: z.ZodType<CapabilityInvocationCompletedPayload> =
  z.object({
    outcome: terminalOutcomeSchema,
    observedStatus: z
      .enum([
        "completed",
        "failed",
        "cancelled",
        "timed-out",
        "uncertain",
        "denied",
        "unavailable",
        "malformed",
        "partial",
      ])
      .optional(),
    degradation: z
      .object({
        decision: z.enum(["fallback-available", "terminal-unavailable"]),
        candidateIds: z.array(brandedString(capabilityId)).max(MAX_CAPABILITY_FALLBACKS_PER_SOURCE),
        terminalReason: z.enum(CAPABILITY_UNAVAILABLE_REASONS),
        recoveryHandles: z.array(z.string().min(1).max(512)).max(MAX_OPPORTUNITY_REASON_CODES),
      })
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
    payload: capabilityInvocationCompletedPayloadSchema,
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
      return { outcome: outcomeToJson(event.payload.outcome) };
    case "capability.invocation.completed":
      return {
        outcome: outcomeToJson(event.payload.outcome),
        ...(event.payload.observedStatus === undefined
          ? {}
          : { observedStatus: event.payload.observedStatus }),
        ...(event.payload.degradation === undefined
          ? {}
          : { degradation: event.payload.degradation }),
      };
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
