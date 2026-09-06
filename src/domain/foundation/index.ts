/** Public contracts for this capability. Internal modules import their exact dependencies. */

export {
  brandedInteger,
  brandedString,
  terminalOutcomeSchema,
  timestampSchema,
  toCodecIssues,
} from "./branded-schema.ts";
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
export type { EnvironmentPort } from "./environment.ts";
export { createStaticEnvironment } from "./environment.ts";
export type {
  CorrelationIds,
  ErrorCategory,
  ExitCategory,
  FalrynError,
  RecoveryAction,
  RuntimeEmittedCategory,
  SafeCause,
} from "./error.ts";
export {
  ERROR_CATEGORIES,
  EXIT_CATEGORIES,
  flattenErrors,
  isErrorCategory,
  isSafeToRetryWithoutInspection,
  MAX_CAUSE_DETAIL_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_RELATED_ERRORS,
  NO_CORRELATION,
  RECOVERY_ACTIONS,
  RUNTIME_EMITTED_CATEGORIES,
  recoveryForEffect,
} from "./error.ts";
export type {
  CapabilityId,
  ConfigurationGeneration,
  EventId,
  EvidenceId,
  FollowUpId,
  HistoryCheckpointId,
  IdempotencyKey,
  IdentifierCodec,
  IdentityError,
  IdentityErrorCode,
  IntegerCodec,
  InvocationId,
  LoomManifestId,
  ManagedServiceId,
  MemoryId,
  ModelAttemptId,
  ModelId,
  ObservationId,
  OutcomeId,
  ProcessCaptureId,
  ProviderId,
  PtySessionId,
  RecommendationId,
  RunId,
  ScopeId,
  Sequence,
  ServiceGeneration,
  SessionId,
  StreamId,
  TaskId,
  TraceId,
  TurnId,
  WorkspaceId,
  WorkspaceRootId,
} from "./identity.ts";
export {
  capabilityId,
  configurationGeneration,
  eventId,
  evidenceId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  FIRST_SERVICE_GENERATION,
  followUpId,
  historyCheckpointId,
  idempotencyKey,
  invocationId,
  loomManifestId,
  managedServiceId,
  memoryId,
  modelAttemptId,
  modelId,
  nextSequence,
  nextServiceGeneration,
  observationId,
  outcomeId,
  processCaptureId,
  providerId,
  ptySessionId,
  recommendationId,
  runId,
  scopeId,
  sequence,
  serviceGeneration,
  sessionId,
  streamId,
  taskId,
  traceId,
  turnId,
  workspaceId,
  workspaceRootId,
} from "./identity.ts";
export {
  MAX_EVENT_BYTES,
  MAX_FOLLOW_UP_QUEUE_ENTRIES,
  MAX_FOLLOW_UP_QUEUE_TEXT_UNITS,
  MAX_IDENTIFIER_LENGTH,
  MAX_STREAM_READ_LIMIT,
  RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION,
  RUNTIME_EVENT_SCHEMA_FAMILY,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from "./limits.ts";
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
export type { InterruptSignal, ManualSignalPort, SignalPort, Unsubscribe } from "./signal.ts";
export { createManualSignalPort, INTERRUPT_SIGNALS } from "./signal.ts";
export type { Timestamp, TimestampError } from "./time.ts";
export {
  parseTimestamp,
  timestampFromEpochMilliseconds,
  timestampToEpochMilliseconds,
} from "./time.ts";
