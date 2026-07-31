/**
 * The domain's public entrypoint.
 *
 * Everything Falryn's outer layers may depend on is re-exported here. Deep
 * imports into individual domain modules are not part of the contract, and the
 * domain itself imports no framework, transport, or storage types.
 */

export type {
  ClockPort,
  DurationMs,
  Instant,
  ManualClock,
  TimeError,
  WaitOutcome,
} from "./clock.ts";
export {
  addDuration,
  createManualClock,
  createSystemClock,
  duration,
  elapsedBetween,
  instant,
  parseDuration,
  parseInstant,
  ZERO_DURATION,
} from "./clock.ts";
export { decodeRuntimeEvent, encodedByteLength, encodeRuntimeEvent } from "./codec.ts";
export type { CodecError, CodecIssue } from "./codec-error.ts";
export type { Deadline } from "./deadline.ts";
export {
  deadlineAt,
  deadlineIn,
  deriveDeadline,
  enlargesDeadline,
  isExpired,
  remainingDuration,
} from "./deadline.ts";
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
  ScopeId,
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
  scopeId,
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
  CancellationReason,
  ScopeError,
  ScopeEvent,
  ScopeEventKind,
  ScopeKind,
  ScopeReport,
  ScopeState,
  ScopeStatus,
} from "./scope.ts";
export {
  cancellationOutcomeFor,
  effectSeverity,
  isScopeKind,
  SCOPE_KINDS,
  SCOPE_STATUSES,
  timeoutOutcomeFor,
  worstEffect,
} from "./scope.ts";
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
export type {
  ParticipantReport,
  ParticipantStatus,
  PhaseReport,
  ShutdownError,
  ShutdownLevel,
  ShutdownParticipant,
  ShutdownPhase,
  ShutdownPhaseContext,
  ShutdownReport,
} from "./shutdown.ts";
export {
  DEFAULT_PHASE_GRACE_MS,
  ESCALATED_PHASE_GRACE_MS,
  FORCED_PHASE_GRACE_MS,
  graceForLevel,
  isShutdownPhase,
  MAX_SHUTDOWN_PARTICIPANTS,
  SHUTDOWN_LEVELS,
  SHUTDOWN_PHASES,
} from "./shutdown.ts";
export type { InterruptSignal, ManualSignalPort, SignalPort, Unsubscribe } from "./signal.ts";
export { createManualSignalPort, INTERRUPT_SIGNALS } from "./signal.ts";
export type { StoredEvent } from "./stored-event.ts";
export { fromStoredEvent, toStoredEvent } from "./stored-event.ts";
export type { Timestamp, TimestampError } from "./time.ts";
export {
  parseTimestamp,
  timestampFromEpochMilliseconds,
  timestampToEpochMilliseconds,
} from "./time.ts";
