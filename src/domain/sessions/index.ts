/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  AttemptAction,
  AttemptClassification,
  AttemptFact,
  AttemptFailureCategory,
  AttemptIdentity,
  DecideAttemptActionInput,
  RefusalFinishReason,
  RefusalSource,
} from "./attempt-policy.ts";
export {
  ATTEMPT_FAILURE_CATEGORIES,
  classifyAttempt,
  decideAttemptAction,
  isAttemptFailureCategory,
  isRefusalFinishReason,
  REFUSAL_FINISH_REASONS,
  terminalOutcomeForClassification,
} from "./attempt-policy.ts";
export { decodeRuntimeEvent, encodedByteLength, encodeRuntimeEvent } from "./codec.ts";
export type {
  CapabilityInvocationCompletedEvent,
  CapabilityInvocationCompletedPayload,
  CapabilityInvocationStartedEvent,
  CapabilityInvocationStartedPayload,
  ConfigurationApplicationClass,
  ConfigurationGenerationChangedEvent,
  ConfigurationGenerationChangedPayload,
  EmptyPayload,
  EventKind,
  EventSummary,
  ModelAttemptBinding,
  ModelAttemptCompletedEvent,
  ModelAttemptStartedEvent,
  ModelAttemptStartedPayload,
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
  EffectiveExecutionPolicy,
  ExecutionProfile,
  ExecutionProfileCompletion,
  ExecutionProfileId,
  ExecutionProfileReasoningRequest,
  ExecutionProfileWorkIntent,
} from "./execution-profile.ts";
export {
  EXECUTION_PROFILE_COMPLETIONS,
  EXECUTION_PROFILE_IDS,
  EXECUTION_PROFILE_REASONING_REQUESTS,
  EXECUTION_PROFILE_SCHEMA_VERSION,
  EXECUTION_PROFILES,
  executionProfile,
  isExecutionProfileId,
  resolveExecutionProfile,
} from "./execution-profile.ts";
export type {
  ExportArtifactEntry,
  ExportBound,
  ExportConfigurationEntry,
  ExportCounts,
  ExportError,
  ExportInventory,
  ExportManifest,
  ExportMember,
  ExportMemberCheck,
  ExportMemberKind,
  ExportOmission,
  ExportOmissionReason,
  ExportRedaction,
  ExportRedactionKind,
  ExportResult,
  ExportSchemaFamily,
  ExportSchemaFamilyDeclaration,
  ExportSelection,
  ExportSelectionKind,
  ExportSelectionSummary,
  ExportVerification,
  MemberCheckStatus,
} from "./export.ts";
export {
  artifactMemberName,
  DEFAULT_PACKAGE_MAX_BYTES,
  EMPTY_COUNTS,
  EXPORT_BOUNDS,
  EXPORT_FOOTER_BYTES,
  EXPORT_FOOTER_DIGITS,
  EXPORT_FORMAT,
  EXPORT_MEMBER_KINDS,
  EXPORT_OMISSION_REASONS,
  EXPORT_REDACTION_KINDS,
  EXPORT_SCHEMA_FAMILIES,
  EXPORT_SCHEMA_VERSION,
  EXPORT_SELECTION_KINDS,
  exportName,
  isCompatible,
  MAX_EXPORT_CONFIGURATION_ENTRIES,
  MAX_EXPORT_CONFIGURATION_KEY,
  MAX_EXPORT_CONFIGURATION_VALUE,
  MAX_EXPORT_MEMBERS,
  MAX_EXPORT_NAME_LENGTH,
  MAX_EXPORT_REDACTION_DEPTH,
  MAX_EXPORT_REDACTION_PATH,
  MAX_EXPORT_REDACTIONS,
  MAX_EXPORTED_ARTIFACTS,
  MAX_EXPORTED_EVENTS,
  MAX_EXPORTED_SESSIONS,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MEMBER_CHECK_STATUSES,
  MIN_PACKAGE_MAX_BYTES,
  MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
  parseExportManifest,
  RECORDS_MEMBER,
  redactExportValue,
  selectedSessions,
  summarize,
} from "./export.ts";
export type {
  ActiveTurnTarget,
  FollowUpEntry,
  FollowUpQueue,
  MidTurnClassification,
  MidTurnClassifyError,
  MidTurnClassifyOk,
  MidTurnIntent,
  MidTurnRequestSnapshot,
  MidTurnSemanticEvent,
  MidTurnSessionView,
} from "./mid-turn-input.ts";
export {
  applyFollowUpAsSteer,
  classifyMidTurnInput,
  describeMidTurnClassifyError,
  dropFollowUp,
  emptyFollowUpQueue,
  enqueueFollowUp,
  followUpQueueTextUnits,
  MID_TURN_CLASSIFICATIONS,
  MID_TURN_INTENTS,
  promoteFollowUp,
  refuseSecondInFlightTurn,
  takeHeadFollowUpForNextTurn,
} from "./mid-turn-input.ts";
export {
  followUpQueueOrder,
  followUpQueueOrderFromEntries,
  toWireMidTurnEvent,
} from "./mid-turn-wire.ts";
export type {
  ProjectionCheckpointReport,
  ProjectionCursor,
  ProjectionError,
  ProjectionName,
  ProjectionRunReport,
  RecordCompletion,
} from "./projection.ts";
export {
  isProjectionName,
  MAX_CHECKPOINTED_STREAMS,
  PROJECTION_NAMES,
  PROJECTION_PAGE_SIZE,
  parseProjectionCursor,
  reduceCompletions,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
} from "./projection.ts";
export type {
  InvocationRecord,
  InvocationRepositoryPort,
  ModelAttemptRecord,
  ModelAttemptRepositoryPort,
  RecordCompletionInput,
  RecordEntity,
  RecordError,
  RecordRepositories,
  RecordRepositoryPort,
  RecordWrite,
  SessionRecord,
  SessionRepositoryPort,
  SessionView,
  TurnRecord,
  TurnRepositoryPort,
  TurnView,
} from "./records.ts";
export {
  MAX_INPUT_DIGEST_LENGTH,
  MAX_RECORD_LIST_LIMIT,
  MAX_SESSION_TITLE_LENGTH,
  outcomeFromColumns,
  parseInvocationRecord,
  parseModelAttemptRecord,
  parseSessionRecord,
  parseTurnRecord,
  RECORD_ENTITIES,
} from "./records.ts";
export type { RetryBackoff, RetryDecision, RetryRefusal, RetryRequest } from "./retry.ts";
export { backoffDelayMs, DEFAULT_RETRY_BACKOFF, evaluateRetry } from "./retry.ts";
export type {
  ArtifactRecoveryOutcome,
  CrashSignals,
  RecoveryCount,
  RecoveryError,
  RecoveryReport,
  RunRecord,
  TemporaryBlobOutcome,
} from "./run.ts";
export {
  ARTIFACT_RECOVERY_OUTCOMES,
  DEFAULT_RECOVERY_WINDOW_MS,
  isPresumedLive,
  MAX_RECOVERED_ARTIFACTS,
  MAX_RECOVERED_BLOBS,
  MAX_RECOVERED_RECORDS,
  MAX_RECOVERY_VERIFIED_BYTES,
  MAX_RECOVERY_WINDOW_MS,
  MIN_RECOVERY_WINDOW_MS,
  NO_CRASH_SIGNALS,
  parseRunRecord,
  TEMPORARY_BLOB_OUTCOMES,
} from "./run.ts";
export type {
  SessionCatalog,
  SessionCatalogEdit,
  SessionCatalogEditInput,
  SessionCatalogEntry,
  SessionCatalogError,
  SessionCatalogErrorCode,
  SessionCatalogFilter,
  SessionCatalogProvenance,
  SessionCatalogQueryInput,
} from "./session-catalog.ts";
export {
  DEFAULT_SESSION_LIST_LIMIT,
  describeSessionCatalogError,
  editSessionCatalog,
  MAX_SESSION_CATALOG,
  MAX_SESSION_SEARCH_BYTES,
  querySessionCatalog,
  SESSION_CATALOG_FILTERS,
  SESSION_CATALOG_SOURCE,
  SESSION_CATALOG_VERSION,
} from "./session-catalog.ts";
export type {
  IsolatedSession,
  SessionIsolation,
  SessionIsolationError,
  SessionIsolationErrorCode,
  SessionIsolationInput,
  SessionIsolationProvenance,
  SessionIsolationWarning,
  WorkspaceRootBinding,
} from "./session-isolation.ts";
export {
  describeSessionIsolationError,
  inspectSessionIsolation,
  SESSION_ISOLATION_SOURCE,
  SESSION_ISOLATION_VERSION,
  SESSION_ISOLATION_WARNINGS,
  workspaceBindingFromSet,
} from "./session-isolation.ts";
export type {
  SessionCommand,
  SessionObservation,
  SessionPhase,
  SessionSnapshot,
  SessionTransitionError,
  SessionTransitionResult,
} from "./session-lifecycle.ts";
export {
  applySessionTransition,
  createSessionSnapshot,
  isSessionPhase,
  isSessionTerminalPhase,
  legalSessionCommands,
  SESSION_COMMANDS,
  SESSION_LIFECYCLE_SCHEMA_VERSION,
  SESSION_PHASES,
  sessionPhaseLabel,
} from "./session-lifecycle.ts";
export type {
  SessionRecoveryBackupPlan,
  SessionRecoveryConfirmation,
  SessionRecoveryConfirmationRequest,
  SessionRecoveryDiagnosticsPlan,
  SessionRecoveryError,
  SessionRecoveryErrorCode,
  SessionRecoveryExportPlan,
  SessionRecoveryImportPlan,
  SessionRecoveryInput,
  SessionRecoveryInspectBackupPlan,
  SessionRecoveryKind,
  SessionRecoveryPlan,
  SessionRecoveryProvenance,
  SessionRecoveryRestorePlan,
} from "./session-recovery.ts";
export {
  describeSessionRecoveryError,
  planSessionRecovery,
  SESSION_RECOVERY_KINDS,
  SESSION_RECOVERY_SOURCE,
  SESSION_RECOVERY_VERSION,
  sessionRecoveryConfirmationRequest,
} from "./session-recovery.ts";
export type {
  ExportRecordEntity,
  ExportRecordLine,
  ImportError,
  ImportIdentityPolicy,
  ImportResult,
  SessionFork,
  SessionReplay,
} from "./session-replay.ts";
export {
  EXPORT_RECORD_ENTITIES,
  IMPORT_IDENTITY_POLICIES,
  parseExportRecordLine,
} from "./session-replay.ts";
export type {
  SessionReplayControlError,
  SessionReplayControlErrorCode,
  SessionReplayControlInput,
  SessionReplayControlProvenance,
  SessionReplayControlState,
  SessionReplayControlStatus,
} from "./session-replay-control.ts";
export {
  controlSessionReplay,
  describeSessionReplayControlError,
  SESSION_REPLAY_CONTROL_SOURCE,
  SESSION_REPLAY_CONTROL_STATUSES,
  SESSION_REPLAY_CONTROL_VERSION,
} from "./session-replay-control.ts";
export type {
  SessionResumeError,
  SessionResumeErrorCode,
  SessionResumeInput,
  SessionResumeKind,
  SessionResumePlan,
  SessionResumeProvenance,
} from "./session-resume.ts";
export {
  describeSessionResumeError,
  planSessionResume,
  SESSION_RESUME_SOURCE,
  SESSION_RESUME_VERSION,
} from "./session-resume.ts";
export type {
  SessionRewindError,
  SessionRewindErrorCode,
  SessionRewindInput,
  SessionRewindKind,
  SessionRewindPlan,
  SessionRewindProvenance,
} from "./session-rewind.ts";
export {
  describeSessionRewindError,
  planSessionRewind,
  SESSION_REWIND_KINDS,
  SESSION_REWIND_SOURCE,
  SESSION_REWIND_VERSION,
} from "./session-rewind.ts";
export type { StoredEvent } from "./stored-event.ts";
export { fromStoredEvent, toStoredEvent } from "./stored-event.ts";
export type {
  BuildTurnEventInput,
  ReplayedAttempt,
  ReplayedInvocation,
  ReplayedTurn,
  TurnEventReduction,
  TurnLifecycleFact,
  TurnReplayClassification,
} from "./turn-events.ts";
export {
  buildTurnLifecycleEvent,
  classifyTurnReplay,
  eventIdForFact,
  factIdentity,
  idempotencyKeyForFact,
  reduceTurnEvents,
} from "./turn-events.ts";
export type {
  ActiveTurnSnapshot,
  TerminalTurnSnapshot,
  TurnCommand,
  TurnObservation,
  TurnPhase,
  TurnSnapshot,
  TurnTransitionError,
  TurnTransitionResult,
} from "./turn-machine.ts";
export {
  applyTurnTransition,
  createTurnSnapshot,
  isTurnPhase,
  legalTurnCommands,
  TURN_COMMANDS,
  TURN_MACHINE_SCHEMA_VERSION,
  TURN_PHASES,
  turnPhaseLabel,
} from "./turn-machine.ts";
export type { WireParseResult } from "./wire.ts";
export { parseWireEvent, toWireEvent } from "./wire.ts";
