/**
 * The application layer's public entrypoint.
 *
 * Outer layers depend on this file, never on individual modules inside it. The
 * layer depends on `src/domain` and on nothing further out.
 */

export type { DurableArtifactApi } from "./artifact-api.ts";
export { createDurableArtifactApi } from "./artifact-api.ts";
export type { ArtifactReader } from "./artifact-read.ts";
export { createArtifactReader } from "./artifact-read.ts";
export type { ArtifactViewer } from "./artifact-view.ts";
export { createArtifactViewer } from "./artifact-view.ts";
export type {
  BoundedQueue,
  BoundedQueueOptions,
  EnqueueRequest,
} from "./bounded-queue.ts";
export { createBoundedQueue } from "./bounded-queue.ts";
export type {
  BriefComposer,
  BriefComposerError,
  BriefComposerResult,
} from "./brief.ts";
export { briefSection, createBriefComposer } from "./brief.ts";
export type { BudgetLedger } from "./budget-ledger.ts";
export { createBudgetLedger, MAX_BUDGET_DEPTH } from "./budget-ledger.ts";
export type { CompactDocumentReader } from "./compact-document-read.ts";
export { createCompactDocumentReader } from "./compact-document-read.ts";
export type {
  CompactLaneError,
  CompactLaneRequest,
  CompactLanes,
  HistoryLaneRequest,
  OverflowLaneRequest,
  WindowPreviewRequest,
} from "./compact-lanes.ts";
export { compactToEvidence, createCompactLanes } from "./compact-lanes.ts";
export type {
  ComposerContextRequest,
  ComposerContextResolution,
  FileAttachmentProbe,
} from "./composer-context.ts";
export {
  admitComposerContext,
  createFileAttachmentProbe,
  digestBytes,
  refreshAttachments,
  resolveComposerAttachments,
} from "./composer-context.ts";
export type {
  CompressionEvalPort,
  CompressionEvalPortError,
} from "./compression-eval.ts";
export {
  createCompressionEvaluator,
  observationFromCompact,
  observationFromHistoryCheckpoint,
  observationFromStructural,
} from "./compression-eval.ts";
export type { SecretResolverOptions } from "./credential-resolver.ts";
export { createSecretResolver } from "./credential-resolver.ts";
export type { DebugAdapterListener, DebugAdapterSupervisor } from "./debug-adapter.ts";
export {
  createDebugAdapterSupervisor,
  describeDebugAdapterFailure,
} from "./debug-adapter.ts";
export type { DiagnosticsCollector, EmitOutcome, EmitRequest } from "./diagnostics-collector.ts";
export { createDiagnosticsCollector, DIAGNOSTICS_OWNERSHIP } from "./diagnostics-collector.ts";
export type { ErrorContext } from "./error-translation.ts";
export {
  adoptForeignError,
  aggregate,
  fromCodecError,
  fromConfigurationIssue,
  fromConfigurationIssues,
  fromCredentialFailure,
  fromEventStoreError,
  fromIdentityError,
  fromParticipantReports,
  fromRemovalRefusal,
  fromRendererFailure,
  fromSequenceError,
  fromSqliteStoreError,
  fromTimestampError,
  fromUnknown,
  fromUnreadConfigurationSource,
  fromUnreadConfigurationSources,
  withContext,
} from "./error-translation.ts";
export type {
  HushEvidenceRequest,
  HushIntegrator,
  HushIntegratorOptions,
  HushObservation,
  HushObservationError,
  HushObserveRequest,
  HushOrigin,
  HushReduceRequest,
} from "./hush.ts";
export { createHushIntegrator, expectedFamiliesForOrigin, HUSH_ORIGINS } from "./hush.ts";
export type { ImageReader } from "./image-read.ts";
export { createImageReader } from "./image-read.ts";
export type {
  InterruptionDecision,
  InterruptionPolicy,
  InterruptionState,
} from "./interruption.ts";
export { attachInterruptionPolicy, createInterruptionPolicy } from "./interruption.ts";
export type { LanguageReader } from "./language-read.ts";
export { createLanguageReader } from "./language-read.ts";
export type { LanguageServerListener, LanguageServerSupervisor } from "./language-server.ts";
export {
  createLanguageServerSupervisor,
  describeLanguageServerFailure,
} from "./language-server.ts";
export type {
  LoomEvidenceRequest,
  LoomIngestMember,
  LoomIngestRequest,
  LoomIngestResult,
  LoomPort,
  LoomPortError,
  LoomPortOptions,
  LoomRetrieveRequest,
} from "./loom.ts";
export { createLoomPort, loomProjectionToEvidence } from "./loom.ts";
export type { MemoryAdmissionPort } from "./memory-admission.ts";
export { createMemoryAdmission } from "./memory-admission.ts";
export type { MemoryIsolation } from "./memory-isolation.ts";
export { createMemoryIsolation } from "./memory-isolation.ts";
export type { OperationalLearning } from "./memory-learning.ts";
export { createOperationalLearning } from "./memory-learning.ts";
export type { MemoryLifecycle } from "./memory-lifecycle.ts";
export { createMemoryLifecycle } from "./memory-lifecycle.ts";
export type { MemoryRecallPort } from "./memory-recall.ts";
export { createMemoryRecall } from "./memory-recall.ts";
export type { MemoryRecords } from "./memory-record.ts";
export { createMemoryRecords } from "./memory-record.ts";
export type { NotebookReader } from "./notebook-read.ts";
export { createNotebookReader } from "./notebook-read.ts";
export type { PdfReader } from "./pdf-read.ts";
export { createPdfReader } from "./pdf-read.ts";
export type {
  DigestedPromptRequest,
  PromptComposer,
  PromptComposerError,
  PromptComposerOptions,
  PromptComposerResult,
} from "./prompt-composer.ts";
export { createPromptComposer } from "./prompt-composer.ts";
export { ENHANCEMENT_MODEL_OWNER, enhancePrompt } from "./prompt-enhancement.ts";
export type {
  ConsumeProviderStreamInput,
  ProviderStreamConsumeOutcome,
  ProviderStreamConsumer,
  ProviderStreamConsumerOptions,
} from "./provider-stream-consumer.ts";
export {
  createProviderStreamConsumer,
  DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS,
} from "./provider-stream-consumer.ts";
export type {
  BackoffOutcome,
  ObservationResult,
  RecoveryDescription,
  RecoveryStep,
} from "./recovery.ts";
export {
  awaitBackoff,
  describeRecovery,
  planRecovery,
  recoveryPlan,
  requiresObservationFirst,
} from "./recovery.ts";
export type { DebugWindow, DebugWindowOptions } from "./redaction.ts";
export {
  containsRedactableSecret,
  createRuntimeRedactor,
  isSecretName,
  openDebugWindow,
  REDACTED,
  redactMetadata,
  redactText,
} from "./redaction.ts";
export type {
  DeriveContextOptions,
  DerivedContext,
  RuntimeContext,
  TurnContext,
  TurnIdentity,
} from "./runtime-context.ts";
export {
  contextFromScope,
  deriveContext,
  effectiveChildDeadline,
  toTurnContext,
} from "./runtime-context.ts";
export type { RuntimeLifecycle, RuntimeLifecycleOptions } from "./runtime-lifecycle.ts";
export { createRuntimeLifecycle } from "./runtime-lifecycle.ts";
export type { SchedulerBudget, SchedulerOptions } from "./scheduler.ts";
export { createScheduler, DEFAULT_SCHEDULER_LIMITS } from "./scheduler.ts";
export type {
  DeriveScopeOptions,
  LateEffectRecord,
  ScopeHandle,
  ScopeTree,
  ScopeTreeOptions,
} from "./scope-tree.ts";
export { createScopeTree, MAX_LIVE_SCOPES, MAX_SCOPE_DEPTH } from "./scope-tree.ts";
export type {
  OpenSessionInput,
  SessionCommandInput,
  SessionRuntime,
  SessionRuntimeError,
  SessionRuntimeResult,
} from "./session-runtime.ts";
export { createSessionRuntime } from "./session-runtime.ts";
export type {
  ShutdownCoordinator,
  ShutdownCoordinatorOptions,
  ShutdownOptions,
} from "./shutdown-coordinator.ts";
export { createShutdownCoordinator } from "./shutdown-coordinator.ts";
export type {
  StructuralEvidenceRequest,
  StructuralPortError,
  StructuralReduceRequest,
  StructuralReducer,
} from "./structural-reduce.ts";
export { createStructuralReducer, structuralToEvidence } from "./structural-reduce.ts";
export { decomposeOutcome } from "./task-decompose.ts";
export { planOutcomeTaskGraph } from "./task-graph.ts";
export { recommendOutcomeValidation } from "./task-validation.ts";
export type {
  ContinueModelContext,
  ContinueModelResult,
  RunToolCallLoopInput,
  ToolCallLoop,
  ToolCallLoopBound,
  ToolCallLoopLimits,
  ToolCallLoopOptions,
  ToolCallLoopOutcome,
  ToolRunnerPort,
  ToolRunnerRequest,
} from "./tool-call-loop.ts";
export {
  createToolCallLoop,
  DEFAULT_TOOL_CALL_LOOP_LIMITS,
} from "./tool-call-loop.ts";
export type {
  PostHookRunResult,
  PreHookRunResult,
  RunToolHooksInput,
  ToolHookRunner,
  ToolHookRunnerOptions,
} from "./tool-hook-runner.ts";
export { createToolHookRunner } from "./tool-hook-runner.ts";
export type { EnvelopeToolResultInput, ToolResultEnvelope } from "./tool-result-envelope.ts";
export { envelopeToolResult } from "./tool-result-envelope.ts";
export type {
  RunToolWorkInput,
  ToolWorkBatchOutcome,
  ToolWorkScheduler,
  ToolWorkSchedulerLimits,
  ToolWorkSchedulerOptions,
} from "./tool-work-scheduler.ts";
export {
  createToolWorkScheduler,
  DEFAULT_TOOL_WORK_SCHEDULER_LIMITS,
} from "./tool-work-scheduler.ts";
export type {
  AttemptRecord,
  AttemptRunnerPort,
  AttemptRunnerRequest,
  AttemptRunnerResult,
  RunTurnAttemptPolicyInput,
  TurnAttemptPolicy,
  TurnAttemptPolicyOptions,
  TurnAttemptPolicyOutcome,
} from "./turn-attempt-policy.ts";
export {
  attemptCategoryForProviderFailure,
  attemptFactFromProviderFailure,
  createTurnAttemptPolicy,
} from "./turn-attempt-policy.ts";
export type {
  StartTurnInput,
  TurnCommandInput,
  TurnCoordinator,
  TurnCoordinatorError,
  TurnCoordinatorResult,
} from "./turn-coordinator.ts";
export { createTurnCoordinator } from "./turn-coordinator.ts";
export type {
  PersistTurnEventsOutcome,
  ReplayTurnEventsOutcome,
  TurnEventJournal,
  TurnEventJournalOptions,
  TurnEventJournalPort,
} from "./turn-event-journal.ts";
export { createTurnEventJournal } from "./turn-event-journal.ts";
export type { VirtualResourceReader } from "./virtual-resource-read.ts";
export { createVirtualResourceReader } from "./virtual-resource-read.ts";
export type {
  WorkspaceIndexBuilder,
  WorkspaceIndexBuilderOptions,
} from "./workspace-index-build.ts";
export { createWorkspaceIndexBuilder } from "./workspace-index-build.ts";
export type { WorkspaceListing } from "./workspace-listing.ts";
export { createWorkspaceListing } from "./workspace-listing.ts";
export type { WorkspaceMutator, WorkspaceMutatorOptions } from "./workspace-mutate.ts";
export { createWorkspaceMutator } from "./workspace-mutate.ts";
export type { PatchPort, WorkspacePatcher, WorkspacePatcherOptions } from "./workspace-patch.ts";
export { createWorkspacePatcher } from "./workspace-patch.ts";
export type { WorkspacePathBinder, WorkspacePathProbeError } from "./workspace-path.ts";
export { createWorkspacePathBinder } from "./workspace-path.ts";
export type { WorkspaceReader, WorkspaceReaderOptions } from "./workspace-read.ts";
export { createWorkspaceReader } from "./workspace-read.ts";
export type { WorkspaceWriter, WorkspaceWriterOptions } from "./workspace-write.ts";
export { createWorkspaceWriter } from "./workspace-write.ts";
