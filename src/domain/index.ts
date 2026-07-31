/**
 * The domain's public entrypoint.
 *
 * Everything Falryn's outer layers may depend on is re-exported here. Deep
 * imports into individual domain modules are not part of the contract, and the
 * domain itself imports no framework, transport, or storage types.
 */

export { decodeRuntimeEvent, encodedByteLength, encodeRuntimeEvent } from "./codec.ts";
export type { CodecError, CodecIssue } from "./codec-error.ts";
export type {
  CapabilityInvocationCompletedEvent,
  CapabilityInvocationStartedEvent,
  ConfigurationApplicationClass,
  ConfigurationGenerationChangedEvent,
  ConfigurationGenerationChangedPayload,
  EmptyPayload,
  EventKind,
  EventSummary,
  ModelAttemptCompletedEvent,
  ModelAttemptStartedEvent,
  ModelEvent,
  RuntimeEvent,
  SessionCorrelation,
  SessionStartedEvent,
  TerminalPayload,
  ToolEvent,
  TurnCompletedEvent,
  TurnCorrelation,
  TurnStartedEvent,
} from "./event.ts";
export {
  CONFIGURATION_APPLICATION_CLASSES,
  EVENT_KINDS,
  isEventKind,
  isModelEvent,
  isToolEvent,
  summarizeEvent,
} from "./event.ts";
export type {
  AppendReceipt,
  EventCursor,
  EventStoreError,
  EventStorePort,
} from "./event-store.ts";
export { createInMemoryEventStore } from "./event-store.ts";
export type {
  CapabilityId,
  ConfigurationGeneration,
  EventId,
  IdempotencyKey,
  IdentifierCodec,
  IdentityError,
  IdentityErrorCode,
  IntegerCodec,
  InvocationId,
  ModelAttemptId,
  Sequence,
  SessionId,
  StreamId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./identity.ts";
export {
  capabilityId,
  configurationGeneration,
  eventId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  idempotencyKey,
  invocationId,
  modelAttemptId,
  nextSequence,
  sequence,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "./identity.ts";
export {
  MAX_EVENT_BYTES,
  MAX_IDENTIFIER_LENGTH,
  MAX_STREAM_READ_LIMIT,
  RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION,
  RUNTIME_EVENT_SCHEMA_FAMILY,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from "./limits.ts";
export type { EffectCertainty, TerminalOutcome, TerminalOutcomeKind } from "./outcome.ts";
export {
  EFFECT_CERTAINTIES,
  effectOf,
  isTerminalOutcomeKind,
  requiresInspection,
  TERMINAL_OUTCOME_KINDS,
} from "./outcome.ts";
export type { Err, Ok, Result } from "./result.ts";
export { assertNever, err, ok } from "./result.ts";
export type {
  AppendDecision,
  ReplayAnomaly,
  ReplayReport,
  SequenceError,
  StreamSequencer,
} from "./sequence.ts";
export {
  createStreamSequencer,
  inspectReplay,
  MAX_TRACKED_EVENTS_PER_STREAM,
} from "./sequence.ts";
export type { StoredEvent } from "./stored-event.ts";
export { fromStoredEvent, toStoredEvent } from "./stored-event.ts";
export type { Timestamp, TimestampError } from "./time.ts";
export {
  parseTimestamp,
  timestampFromEpochMilliseconds,
  timestampToEpochMilliseconds,
} from "./time.ts";
