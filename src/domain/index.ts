/**
 * The domain's public entrypoint.
 *
 * Everything Falryn's outer layers may depend on is re-exported here. Deep
 * imports into individual domain modules are not part of the contract, and the
 * domain itself imports no framework, transport, or storage types.
 */

export type {
  BudgetAmounts,
  BudgetDimension,
  BudgetError,
  BudgetId,
  BudgetLimits,
  BudgetReport,
  DimensionReport,
  ReservationId,
} from "./budget.ts";
export {
  BUDGET_DIMENSIONS,
  enlargesLimits,
  isBudgetDimension,
  narrowLimits,
  validateAmounts,
} from "./budget.ts";
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
export type {
  ConfigurationAlias,
  ConfigurationDeprecation,
  ConfigurationIssue,
  ConfigurationIssueKind,
  ConfigurationIssueSeverity,
  ConfigurationKeyDescriptor,
  ConfigurationKeyPath,
  ConfigurationKeyPathError,
  ConfigurationKeyPathErrorCode,
  ConfigurationKeyResolution,
  ConfigurationLayerContext,
  ConfigurationLimit,
  ConfigurationMergeBehavior,
  ConfigurationRegistryPort,
  ConfigurationScope,
  ConfigurationSensitivity,
  ConfigurationSourceKind,
  ConfigurationUnit,
  ConfigurationValidationResult,
  ConfigurationValue,
  ConfigurationValues,
  ConfigurationValueType,
  CredentialReference,
  CredentialStoreKind,
  SensitiveValueRedactor,
} from "./configuration.ts";
export {
  blockingIssues,
  CONFIGURATION_SCOPES,
  CONFIGURATION_SENSITIVITIES,
  CONFIGURATION_SOURCE_KINDS,
  CONFIGURATION_UNITS,
  CONFIGURATION_VALUE_TYPES,
  CREDENTIAL_STORE_KINDS,
  configurationKeyPath,
  isBlockingIssue,
  isConfigurationScope,
  isUnlimited,
  MAX_CONFIGURATION_KEY_PATH_LENGTH,
  parseConfigurationKeyPath,
  scopeForSourceKind,
  UNLIMITED,
} from "./configuration.ts";
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
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticSubsystem,
  DiagnosticsReport,
  DiagnosticValue,
} from "./diagnostics.ts";
export {
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_SUBSYSTEMS,
  isDiagnosticSubsystem,
  MAX_DEBUG_PREVIEW_LENGTH,
  MAX_DEBUG_PREVIEWS,
  MAX_DEBUG_WINDOW_MS,
  MAX_DIAGNOSTIC_CARDINALITY,
  MAX_DIAGNOSTIC_METADATA_KEYS,
  MAX_DIAGNOSTIC_VALUE_LENGTH,
  MAX_RETAINED_DIAGNOSTICS,
} from "./diagnostics.ts";
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
  CreateDirectoryOutcome,
  FileKind,
  FileSystemError,
  FileSystemErrorCode,
  FileSystemOperation,
  FileSystemPort,
  InMemoryFileSystemOptions,
  InMemoryNode,
  LocalPath,
  LocalPathError,
  LocalPathErrorCode,
  PathEntry,
} from "./filesystem.ts";
export {
  baseName,
  createInMemoryFileSystem,
  isInside,
  joinPath,
  localPath,
  MAX_LOCAL_PATH_LENGTH,
  parseLocalPath,
} from "./filesystem.ts";
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
export type {
  ClassBudget,
  ClassPressure,
  ClassUsage,
  DurabilityClass,
  FailedPath,
  LocalDataPlatform,
  LocalDataRoot,
  MeasurementCompleteness,
  OutOfScopeCategory,
  OwnershipClass,
  OwnershipRegistration,
  PlanId,
  PlannedAction,
  PlannedClass,
  PlannedReason,
  QuotaPressure,
  ReconciledEntry,
  ReconciliationReport,
  RegistrationError,
  RegistrationErrorCode,
  RemovalConfirmation,
  RemovalKind,
  RemovalOutcome,
  RemovalPlan,
  RemovalPosture,
  RemovalRefusal,
  ResolvedRoot,
  RetainedPath,
  RetentionPolicy,
  RetentionReason,
  RetentionReport,
  RootLayout,
  RootProvenance,
  RootStatus,
  RootStatusCode,
} from "./local-data.ts";
export {
  DURABILITY_CLASSES,
  isLocalDataRoot,
  isOwnershipClass,
  isRootUsable,
  LOCAL_DATA_PLATFORMS,
  LOCAL_DATA_ROOTS,
  OUT_OF_SCOPE_CATEGORIES,
  OWNERSHIP_CLASSES,
  PLANNED_ACTIONS,
  PLANNED_REASONS,
  QUOTA_PRESSURES,
  REMOVAL_POSTURES,
  RETENTION_REASONS,
  ROOT_STATUS_CODES,
} from "./local-data.ts";
export type { EffectCertainty, TerminalOutcome, TerminalOutcomeKind } from "./outcome.ts";
export {
  EFFECT_CERTAINTIES,
  effectOf,
  isTerminalOutcomeKind,
  requiresInspection,
  TERMINAL_OUTCOME_KINDS,
} from "./outcome.ts";
export type {
  ArtifactHandle,
  ArtifactSpillPort,
  EnqueueOutcome,
  LimitKind,
  OverflowPolicy,
  QueueItem,
  QueueItemId,
  QueueLimits,
  QueueReport,
} from "./queue.ts";
export { OVERFLOW_POLICIES } from "./queue.ts";
export type { Err, Ok, Result } from "./result.ts";
export { assertNever, err, ok } from "./result.ts";
export type { RetryBackoff, RetryDecision, RetryRefusal, RetryRequest } from "./retry.ts";
export { backoffDelayMs, DEFAULT_RETRY_BACKOFF, evaluateRetry } from "./retry.ts";
export type {
  QueueDepthByPriority,
  RecoveryOption,
  ScheduledWork,
  SchedulerLimits,
  SchedulerPort,
  SchedulerReport,
  SchedulingError,
  SchedulingResult,
  WorkRunner,
} from "./scheduling.ts";
export { RECOVERY_OPTIONS } from "./scheduling.ts";
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
export type {
  ConflictKey,
  EffectClass,
  PriorityClass,
  RetryPolicy,
  WorkUnit,
  WorkUnitError,
  WorkUnitId,
} from "./work.ts";
export {
  conflictKey,
  EFFECT_CLASSES,
  effectiveConflictKeys,
  GLOBAL_CONFLICT_KEY,
  isEffectClass,
  isFreelyParallel,
  isPriorityClass,
  MAX_WORK_IDENTIFIER_LENGTH,
  NO_RETRY,
  PRIORITY_CLASSES,
  parseWorkUnitId,
  priorityRank,
  workUnitId,
} from "./work.ts";
