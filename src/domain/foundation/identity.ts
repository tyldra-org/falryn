/**
 * Branded runtime identities.
 *
 * Identifiers are opaque strings that cannot be substituted for one another,
 * so a session identifier can never be passed where a turn identifier belongs.
 * Numeric identities are branded too, because sequence and configuration
 * generation are both integers and are both easy to transpose.
 */

import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";
import { err, ok, type Result } from "./result.ts";

declare const brand: unique symbol;

/**
 * The domain's branding helper.
 *
 * Exported for other domain modules that own an opaque primitive of their own,
 * such as a configuration key path. It is not part of the domain's public
 * surface: outer layers consume the branded types, never the helper.
 */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WorkspaceId = Brand<string, "WorkspaceId">;
/** One bound root inside a multi-root workspace set (#604). */
export type WorkspaceRootId = Brand<string, "WorkspaceRootId">;
/** One execution of the Falryn process, from start to clean end. */
export type RunId = Brand<string, "RunId">;
export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type ModelAttemptId = Brand<string, "ModelAttemptId">;
export type InvocationId = Brand<string, "InvocationId">;
/** An artifact's logical identity. Stable across deduplicated bytes. */
export type ArtifactId = Brand<string, "ArtifactId">;
/** A digest over one artifact's exact bytes, including its algorithm prefix. */
export type ContentDigest = Brand<string, "ContentDigest">;
export type CapabilityId = Brand<string, "CapabilityId">;
export type EventId = Brand<string, "EventId">;
/** One admitted context-engine evidence candidate. */
export type EvidenceId = Brand<string, "EvidenceId">;
export type TraceId = Brand<string, "TraceId">;
export type StreamId = Brand<string, "StreamId">;
export type ScopeId = Brand<string, "ScopeId">;
export type ProcessCaptureId = Brand<string, "ProcessCaptureId">;
export type PtySessionId = Brand<string, "PtySessionId">;
export type ManagedServiceId = Brand<string, "ManagedServiceId">;
/** One Loom compress-cache-retrieve manifest grouping exact artifacts. */
export type LoomManifestId = Brand<string, "LoomManifestId">;
/** One conversation-history compaction checkpoint. The event log is not rewritten. */
export type HistoryCheckpointId = Brand<string, "HistoryCheckpointId">;
/** One durable memory record. Corrections create a new id; the old record is not rewritten. */
export type MemoryId = Brand<string, "MemoryId">;
/** One queued follow-up user request on a session (#611). */
export type FollowUpId = Brand<string, "FollowUpId">;
/** One bounded operational observation. Aggregates only; never a durable fact. */
export type ObservationId = Brand<string, "ObservationId">;
/** One reviewable operational recommendation. Never auto-applied. */
export type RecommendationId = Brand<string, "RecommendationId">;
/** A user-stated outcome to be decomposed into bounded tasks. */
export type OutcomeId = Brand<string, "OutcomeId">;
/** One bounded task produced from a user outcome. Advice only; never an execution. */
export type TaskId = Brand<string, "TaskId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
/** Which provider a model attempt was routed to, such as an API vendor. */
export type ProviderId = Brand<string, "ProviderId">;
/** Which model that provider was asked for. Opaque: providers name their own. */
export type ModelId = Brand<string, "ModelId">;

export type ConfigurationGeneration = Brand<number, "ConfigurationGeneration">;
export type ServiceGeneration = Brand<number, "ServiceGeneration">;
export type Sequence = Brand<number, "Sequence">;

/** First legal sequence number in any stream. Sequences are one-based. */
export const FIRST_SEQUENCE = 1 as Sequence;

/** First legal configuration generation. Generations are zero-based. */
export const FIRST_CONFIGURATION_GENERATION = 0 as ConfigurationGeneration;

export type IdentityErrorCode =
  | "identifier-empty"
  | "identifier-too-long"
  | "identifier-illegal-character"
  | "identifier-not-a-string"
  | "number-not-an-integer"
  | "number-out-of-range";

export type IdentityError = {
  readonly kind: "identity";
  readonly code: IdentityErrorCode;
  /** Which identity was rejected. Never carries the rejected value. */
  readonly identity: string;
};

function identityError(code: IdentityErrorCode, identity: string): IdentityError {
  return { kind: "identity", code, identity };
}

/**
 * Printable ASCII without space or control characters.
 *
 * Identifiers appear in stream keys, log lines, and file names, so they exclude
 * whitespace and control characters that would make those surfaces ambiguous.
 */
const LEGAL_IDENTIFIER = /^[!-~]+$/;

export type IdentifierCodec<Id extends string> = {
  readonly identity: string;
  /** Validates untrusted input. Use at every boundary. */
  parse(value: unknown): Result<Id, IdentityError>;
  /**
   * Validates trusted input and throws {@link IdentityError} on rejection.
   * Use only where an invalid value is a defect, such as a literal in a test.
   */
  from(value: string): Id;
};

function createIdentifierCodec<Id extends string>(identity: string): IdentifierCodec<Id> {
  const parse = (value: unknown): Result<Id, IdentityError> => {
    if (typeof value !== "string") {
      return err(identityError("identifier-not-a-string", identity));
    }
    if (value.length === 0) {
      return err(identityError("identifier-empty", identity));
    }
    if (value.length > MAX_IDENTIFIER_LENGTH) {
      return err(identityError("identifier-too-long", identity));
    }
    if (!LEGAL_IDENTIFIER.test(value)) {
      return err(identityError("identifier-illegal-character", identity));
    }
    return ok(value as Id);
  };

  return {
    identity,
    parse,
    from(value: string): Id {
      const result = parse(value);
      if (!result.ok) {
        throw new Error(`invalid ${identity}: ${result.error.code}`);
      }
      return result.value;
    },
  };
}

export const workspaceId = createIdentifierCodec<WorkspaceId>("workspaceId");
export const workspaceRootId = createIdentifierCodec<WorkspaceRootId>("workspaceRootId");
export const runId = createIdentifierCodec<RunId>("runId");
export const sessionId = createIdentifierCodec<SessionId>("sessionId");
export const turnId = createIdentifierCodec<TurnId>("turnId");
export const modelAttemptId = createIdentifierCodec<ModelAttemptId>("modelAttemptId");
export const invocationId = createIdentifierCodec<InvocationId>("invocationId");
export const capabilityId = createIdentifierCodec<CapabilityId>("capabilityId");
export const eventId = createIdentifierCodec<EventId>("eventId");
export const evidenceId = createIdentifierCodec<EvidenceId>("evidenceId");
export const traceId = createIdentifierCodec<TraceId>("traceId");
export const streamId = createIdentifierCodec<StreamId>("streamId");
export const scopeId = createIdentifierCodec<ScopeId>("scopeId");
export const processCaptureId = createIdentifierCodec<ProcessCaptureId>("processCaptureId");
export const ptySessionId = createIdentifierCodec<PtySessionId>("ptySessionId");
export const managedServiceId = createIdentifierCodec<ManagedServiceId>("managedServiceId");
export const loomManifestId = createIdentifierCodec<LoomManifestId>("loomManifestId");
export const historyCheckpointId =
  createIdentifierCodec<HistoryCheckpointId>("historyCheckpointId");
export const memoryId = createIdentifierCodec<MemoryId>("memoryId");
export const followUpId = createIdentifierCodec<FollowUpId>("followUpId");
export const observationId = createIdentifierCodec<ObservationId>("observationId");
export const recommendationId = createIdentifierCodec<RecommendationId>("recommendationId");
export const outcomeId = createIdentifierCodec<OutcomeId>("outcomeId");
export const taskId = createIdentifierCodec<TaskId>("taskId");
export const idempotencyKey = createIdentifierCodec<IdempotencyKey>("idempotencyKey");
export const providerId = createIdentifierCodec<ProviderId>("providerId");
export const modelId = createIdentifierCodec<ModelId>("modelId");

export type IntegerCodec<Value extends number> = {
  readonly identity: string;
  parse(value: unknown): Result<Value, IdentityError>;
  from(value: number): Value;
};

function createIntegerCodec<Value extends number>(
  identity: string,
  minimum: number,
): IntegerCodec<Value> {
  const parse = (value: unknown): Result<Value, IdentityError> => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      return err(identityError("number-not-an-integer", identity));
    }
    if (value < minimum) {
      return err(identityError("number-out-of-range", identity));
    }
    return ok(value as Value);
  };

  return {
    identity,
    parse,
    from(value: number): Value {
      const result = parse(value);
      if (!result.ok) {
        throw new Error(`invalid ${identity}: ${result.error.code}`);
      }
      return result.value;
    },
  };
}

export const sequence = createIntegerCodec<Sequence>("sequence", FIRST_SEQUENCE);
export const configurationGeneration = createIntegerCodec<ConfigurationGeneration>(
  "configurationGeneration",
  FIRST_CONFIGURATION_GENERATION,
);
export const FIRST_SERVICE_GENERATION = 1 as ServiceGeneration;
export const serviceGeneration = createIntegerCodec<ServiceGeneration>(
  "serviceGeneration",
  FIRST_SERVICE_GENERATION,
);

/** Returns the sequence that must follow `current` in the same stream. */
export function nextSequence(current: Sequence): Sequence {
  return (current + 1) as Sequence;
}

/** Returns the process generation that must follow `current`. */
export function nextServiceGeneration(current: ServiceGeneration): ServiceGeneration {
  return (current + 1) as ServiceGeneration;
}
