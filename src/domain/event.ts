/**
 * The semantic event envelope.
 *
 * Every runtime event carries the same identity spine — event, stream,
 * sequence, kind, schema version, occurrence time, and correlation. Model
 * events add attempt identity and tool events add invocation and capability
 * identity, because those are the correlations their consumers cannot
 * reconstruct from the spine alone.
 *
 * The union is closed. An unknown kind is never widened into a known one; the
 * codec rejects it and preserves the observed string for quarantine.
 */

import type { ExecutionProfileCompletion, ExecutionProfileId } from "./execution-profile.ts";
import type {
  CapabilityId,
  ConfigurationGeneration,
  EventId,
  IdempotencyKey,
  InvocationId,
  ModelAttemptId,
  ModelId,
  ProviderId,
  Sequence,
  SessionId,
  StreamId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import type { Timestamp } from "./time.ts";

export const EVENT_KINDS = [
  "session.started",
  "turn.started",
  "turn.completed",
  "model.attempt.started",
  "model.attempt.completed",
  "capability.invocation.started",
  "capability.invocation.completed",
  "configuration.generation.changed",
  "execution.profile.selected",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * How far a configuration change may propagate.
 *
 * A change never rewrites the generation an in-flight operation started with;
 * the class states when the new generation becomes observable instead.
 */
export const CONFIGURATION_APPLICATION_CLASSES = [
  "live",
  "next-operation",
  "next-turn",
  "reconnect",
  "application-restart",
] as const;

export type ConfigurationApplicationClass = (typeof CONFIGURATION_APPLICATION_CLASSES)[number];

/** Correlation available to every event in a session. */
export type SessionCorrelation = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
};

/** Correlation for work that belongs to one turn. */
export type TurnCorrelation = SessionCorrelation & {
  readonly turnId: TurnId;
};

/** A payload that carries no data of its own beyond the envelope. */
export type EmptyPayload = Record<string, never>;

export type TerminalPayload = {
  readonly outcome: TerminalOutcome;
};

/**
 * Immutable provider and capability snapshot observed by one model attempt.
 *
 * Tool schemas are identified by their canonical digest instead of copied into
 * every event. The bound catalog generation plus digest identifies the exact
 * schema while keeping the semantic journal bounded.
 */
export type ModelAttemptBinding = {
  readonly schemaVersion: 1;
  readonly providerId: ProviderId;
  /** Absent only on events written before exact provider-profile binding shipped. */
  readonly providerProfileId?: string | undefined;
  readonly providerAdapterKind?: string | undefined;
  readonly providerDestinationId?: string | undefined;
  /** Absent only on events written before transport compatibility binding shipped. */
  readonly transportCompatibilityId?: string | undefined;
  readonly modelId: ModelId;
  readonly role: string;
  readonly intent: string | null;
  readonly reasoning: string;
  readonly providerReasoningControl?: string | null | undefined;
  /** Absent only on events written before execution profiles shipped. */
  readonly executionProfile?:
    | {
        readonly id: ExecutionProfileId;
        readonly version: 1;
        readonly completion: ExecutionProfileCompletion;
      }
    | undefined;
  readonly providerCatalogGeneration: number;
  /** Absent only on events written before versioned model capability records shipped. */
  readonly modelCapabilitySchemaVersion?: number | undefined;
  readonly toolCatalogGeneration: ConfigurationGeneration;
  readonly policyGeneration: ConfigurationGeneration;
  readonly runner: "product-attempt-runner.v1";
  readonly gateway: "product-tool-gateway.v1";
  readonly discoveryHandle: string;
  /** Bounded, secret-free inventory facts for replay and support inspection. */
  readonly capabilityCatalog?:
    | {
        readonly total: number;
        readonly counts: Readonly<Record<string, number>>;
        readonly cards: readonly {
          readonly capabilityId: CapabilityId;
          readonly kind: string;
          readonly family: string | null;
          readonly source: string;
          readonly version: number;
          readonly costClass: string;
          readonly latencyClass: string;
          readonly available: boolean;
          readonly executable: boolean;
          readonly disclosed: boolean;
          readonly health?: string | undefined;
          readonly selected?: boolean | undefined;
          readonly projected?: boolean | undefined;
          readonly diagnosticCodes?: readonly string[] | undefined;
        }[];
      }
    | undefined;
  readonly families: readonly {
    readonly family: string;
    readonly available: boolean;
    readonly reason: string | null;
  }[];
  readonly tools: readonly {
    readonly name: string;
    readonly capabilityId: CapabilityId;
    readonly version: number;
    readonly schemaDigest: string;
    readonly schemaBytes: number;
    readonly schemaTokensEstimated: number;
  }[];
  readonly omitted: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
  readonly schemaBytes: number;
  readonly schemaTokensEstimated: number;
  /** Secret-safe prompt-cache receipt; absent on legacy and uncached attempts. */
  readonly promptCache?:
    | {
        readonly schemaVersion: 1;
        readonly key: string;
        readonly scope: "session";
        readonly stablePrefixDigest: string;
        readonly stableMessageCount: number;
        readonly toolCatalogGeneration: number;
        /** Absent only on events written before cache mechanisms were catalog-bound. */
        readonly mode?:
          | "implicit-prefix"
          | "openai-routing-key"
          | "anthropic-ephemeral"
          | "google-explicit-resource"
          | "provider-managed"
          | undefined;
        readonly minimumInputTokens?: number | null | undefined;
      }
    | undefined;
  readonly budgets: {
    readonly attempts: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly wallTimeMs: number | null;
    readonly cost: number | null;
  };
};

export type ModelAttemptStartedPayload = {
  /** Absent only on legacy events written before the live product loop. */
  readonly binding?: ModelAttemptBinding | undefined;
};

/** Durable invocation metadata. Absent only on legacy events. */
export type CapabilityInvocationStartedPayload = {
  readonly capabilityVersion?: number | undefined;
  readonly inputDigest?: string | undefined;
};

export type ConfigurationGenerationChangedPayload = {
  readonly generation: ConfigurationGeneration;
  readonly applicationClass: ConfigurationApplicationClass;
};

export type ExecutionProfileSelectedPayload = {
  readonly selectionId: string;
  readonly profileId: ExecutionProfileId;
  readonly profileVersion: 1;
  readonly completion: ExecutionProfileCompletion;
  readonly applicationClass: "next-turn";
};

type Envelope<Kind extends EventKind, Correlation, Payload> = {
  readonly eventId: EventId;
  /** The stream this event is sequenced within. Persists as `aggregateId`. */
  readonly streamId: StreamId;
  readonly sequence: Sequence;
  readonly kind: Kind;
  /** The version this event was written at. */
  readonly schemaVersion: number;
  /**
   * The lowest reader version able to interpret this event's required
   * semantics. A reader below it must reject rather than guess.
   */
  readonly minimumReaderSchemaVersion: number;
  readonly occurredAt: Timestamp;
  /** Makes a re-append after a retry a no-op instead of a second event. */
  readonly idempotencyKey: IdempotencyKey;
  readonly correlation: Correlation;
  readonly payload: Payload;
};

export type SessionStartedEvent = Envelope<"session.started", SessionCorrelation, EmptyPayload>;

export type TurnStartedEvent = Envelope<"turn.started", TurnCorrelation, EmptyPayload>;

export type TurnCompletedEvent = Envelope<"turn.completed", TurnCorrelation, TerminalPayload>;

export type ModelAttemptStartedEvent = Envelope<
  "model.attempt.started",
  TurnCorrelation,
  ModelAttemptStartedPayload
> & {
  readonly modelAttemptId: ModelAttemptId;
};

export type ModelAttemptCompletedEvent = Envelope<
  "model.attempt.completed",
  TurnCorrelation,
  TerminalPayload
> & {
  readonly modelAttemptId: ModelAttemptId;
};

export type CapabilityInvocationStartedEvent = Envelope<
  "capability.invocation.started",
  TurnCorrelation,
  CapabilityInvocationStartedPayload
> & {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
};

export type CapabilityInvocationCompletedEvent = Envelope<
  "capability.invocation.completed",
  TurnCorrelation,
  TerminalPayload
> & {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
};

export type ConfigurationGenerationChangedEvent = Envelope<
  "configuration.generation.changed",
  SessionCorrelation,
  ConfigurationGenerationChangedPayload
>;

export type ExecutionProfileSelectedEvent = Envelope<
  "execution.profile.selected",
  SessionCorrelation,
  ExecutionProfileSelectedPayload
>;

export type RuntimeEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ModelAttemptStartedEvent
  | ModelAttemptCompletedEvent
  | CapabilityInvocationStartedEvent
  | CapabilityInvocationCompletedEvent
  | ConfigurationGenerationChangedEvent
  | ExecutionProfileSelectedEvent;

export type ModelEvent = ModelAttemptStartedEvent | ModelAttemptCompletedEvent;

export type ToolEvent = CapabilityInvocationStartedEvent | CapabilityInvocationCompletedEvent;

export function isModelEvent(event: RuntimeEvent): event is ModelEvent {
  return event.kind === "model.attempt.started" || event.kind === "model.attempt.completed";
}

export function isToolEvent(event: RuntimeEvent): event is ToolEvent {
  return (
    event.kind === "capability.invocation.started" ||
    event.kind === "capability.invocation.completed"
  );
}

/**
 * A diagnostic view of an event.
 *
 * Deliberately excludes the payload. Runtime diagnostics report identity,
 * ordering, and size so a secret carried in a payload cannot reach a log,
 * metric, or support bundle through this path.
 */
export type EventSummary = {
  readonly eventId: EventId;
  readonly streamId: StreamId;
  readonly sequence: Sequence;
  readonly kind: EventKind;
  readonly schemaVersion: number;
  readonly occurredAt: Timestamp;
  readonly traceId: TraceId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;
  readonly modelAttemptId: ModelAttemptId | null;
  readonly invocationId: InvocationId | null;
  readonly capabilityId: CapabilityId | null;
};

export function summarizeEvent(event: RuntimeEvent): EventSummary {
  return {
    eventId: event.eventId,
    streamId: event.streamId,
    sequence: event.sequence,
    kind: event.kind,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    traceId: event.correlation.traceId,
    sessionId: event.correlation.sessionId,
    turnId: "turnId" in event.correlation ? event.correlation.turnId : null,
    modelAttemptId: isModelEvent(event) ? event.modelAttemptId : null,
    invocationId: isToolEvent(event) ? event.invocationId : null,
    capabilityId: isToolEvent(event) ? event.capabilityId : null,
  };
}
