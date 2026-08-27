/**
 * The application layer's public entrypoint.
 *
 * Outer layers depend on this file, never on individual modules inside it. The
 * layer depends on `src/domain` and on nothing further out.
 */

export type { DurableArtifactApi } from "./artifact-api.ts";
export { createDurableArtifactApi } from "./artifact-api.ts";
export { type QueryStoredArtifactsInput, queryStoredArtifacts } from "./artifact-catalog.ts";
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
  createTranscriptAttachment,
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
export type {
  ContextPlanner,
  ContextPlannerComposeInput,
  ContextPlannerComposeResult,
  ContextPlannerError,
  ContextPlannerPlan,
} from "./context-planner.ts";
export { CONTEXT_PLANNER_OWNER, createContextPlanner } from "./context-planner.ts";
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
  fromArtifactCatalogError,
  fromArtifactError,
  fromArtifactReadError,
  fromBackupError,
  fromCodecError,
  fromConfigurationIssue,
  fromConfigurationIssues,
  fromCredentialFailure,
  fromEventStoreError,
  fromExportError,
  fromIdentityError,
  fromImportError,
  fromParticipantReports,
  fromRecordError,
  fromRemovalRefusal,
  fromRendererFailure,
  fromSequenceError,
  fromSessionCatalogError,
  fromSessionIsolationError,
  fromSqliteStoreError,
  fromTimestampError,
  fromUnknown,
  fromUnreadConfigurationSource,
  fromUnreadConfigurationSources,
  withContext,
} from "./error-translation.ts";
export type {
  GitDashboard,
  GitDashboardOptions,
  GitDashboardSnapshot,
} from "./git-dashboard.ts";
export { createGitDashboard, describeGitError } from "./git-dashboard.ts";
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
  SyncLanguageServerFoldersError,
  SyncLanguageServerFoldersRequest,
  SyncLanguageServerFoldersResult,
} from "./language-server-workspace.ts";
export {
  describeLanguageServerWorkspaceMapError,
  initializeFoldersFromWorkspaceSet,
  syncLanguageServerFoldersFromWorkspaceSet,
  workspaceFolderSyncSnapshot,
} from "./language-server-workspace.ts";
export type {
  LoomAdoptMember,
  LoomAdoptRequest,
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
export type { MidTurnInputService, MidTurnInputServiceOptions } from "./mid-turn-input.ts";
export { createMidTurnInputService, describeMidTurnClassifyError } from "./mid-turn-input.ts";
export type { NotebookReader } from "./notebook-read.ts";
export { createNotebookReader } from "./notebook-read.ts";
export type { PdfReader } from "./pdf-read.ts";
export { createPdfReader } from "./pdf-read.ts";
export type {
  HostTurnOutcome,
  ProductAgentAttachmentPoints,
  ProductAgentPortResult,
  ProductAgentRuntime,
  ProductAgentRuntimeComposeResult,
  ProductAgentRuntimeError,
  ProductAgentRuntimePorts,
  ProductAgentSessionIds,
} from "./product-agent-runtime.ts";
export { composeProductAgentRuntime } from "./product-agent-runtime.ts";
export type { ProductAttemptRunnerOptions } from "./product-attempt-runner.ts";
export { createProductAttemptRunner } from "./product-attempt-runner.ts";
export type { ProductBriefControls, ProductBriefControlsOptions } from "./product-brief.ts";
export {
  composeProductBriefControls,
  describeBriefVerbosityModes,
  PRODUCT_BRIEF_OWNER,
} from "./product-brief.ts";
export type {
  ProductCredentialBundle,
  ProductCredentialPorts,
} from "./product-credentials.ts";
export {
  composeProductCredentials,
  DEFAULT_OPENAI_CREDENTIAL_REFERENCE,
  resolveProviderApiKey,
} from "./product-credentials.ts";
export type { ProductHushHarnessProjection } from "./product-hush-projection.ts";
export {
  PRODUCT_HUSH_PROJECTION_OWNER,
  projectHushForHarness,
} from "./product-hush-projection.ts";
export type {
  EphemeralProductIndexPort,
  ProductIndexLifecycle,
  ProductIndexLifecyclePorts,
  ProductIndexLifecycleStatus,
} from "./product-index-lifecycle.ts";
export {
  composeProductIndexLifecycle,
  createEphemeralProductIndexPort,
  PRODUCT_INDEX_LIFECYCLE_OWNER,
} from "./product-index-lifecycle.ts";
export type {
  ProductLiveTurnExecutor,
  ProductLiveTurnExecutorOptions,
  ProductLiveTurnInput,
  ProductLiveTurnResult,
} from "./product-live-turn.ts";
export { createProductLiveTurnExecutor, productModelPolicy } from "./product-live-turn.ts";
export type {
  ProductLoomContext,
  ProductLoomContextPorts,
  ProductLoomRecoveryHandle,
} from "./product-loom.ts";
export { composeProductLoomContext, PRODUCT_LOOM_OWNER } from "./product-loom.ts";
export type {
  ProductMemoryTurn,
  ProductMemoryTurnPorts,
  ProductMemoryTurnResult,
} from "./product-memory-turn.ts";
export { composeProductMemoryTurn } from "./product-memory-turn.ts";
export { attemptModelInputFromPrompt } from "./product-model-input.ts";
export type {
  ProductReadCoordinator,
  ProductReadCoordinatorOptions,
  ProductReadResult,
} from "./product-read.ts";
export {
  createProductReadCoordinator,
  DEFAULT_PRODUCT_READ_LOOM_BYTES,
  MAX_PRODUCT_READ_CANDIDATES,
  PRODUCT_READ_OWNER,
  productReadInputSchema,
} from "./product-read.ts";
export type {
  CapabilityDisclosureReceipt,
  CapabilityFamilyAvailability,
  DisclosedProductTool,
  ModelCapabilityFamily,
  ProductToolDisclosure,
} from "./product-tool-disclosure.ts";
export {
  discloseProductTools,
  MAX_DISCLOSED_PRODUCT_TOOLS,
  MODEL_CAPABILITY_FAMILIES,
  PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION,
} from "./product-tool-disclosure.ts";
export type {
  ProductToolConfirmationPort,
  ProductToolConfirmationResult,
  ProductToolEffectLedger,
  ProductToolGatewayOptions,
} from "./product-tool-gateway.ts";
export { createProductToolGateway } from "./product-tool-gateway.ts";
export type {
  ProductGitToolPorts,
  ProductGitTools,
} from "./product-tools-git.ts";
export {
  composeProductGitTools,
  PRODUCT_GIT_TOOLS_OWNER,
} from "./product-tools-git.ts";
export type {
  ProductLanguageToolPorts,
  ProductLanguageTools,
} from "./product-tools-language.ts";
export {
  composeProductLanguageTools,
  PRODUCT_LANGUAGE_TOOLS_OWNER,
} from "./product-tools-language.ts";
export type {
  ProductMemoryToolPorts,
  ProductMemoryTools,
} from "./product-tools-memory.ts";
export {
  composeProductMemoryTools,
  PRODUCT_MEMORY_TOOLS_OWNER,
} from "./product-tools-memory.ts";
export type { ProductToolBundle } from "./product-tools-merge.ts";
export { mergeProductToolBundles } from "./product-tools-merge.ts";
export type {
  ProductProcessToolPorts,
  ProductProcessTools,
} from "./product-tools-process.ts";
export {
  composeProductProcessTools,
  PRODUCT_PROCESS_TOOLS_OWNER,
} from "./product-tools-process.ts";
export type {
  ProductWorkspaceToolPorts,
  ProductWorkspaceTools,
} from "./product-tools-workspace.ts";
export {
  composeProductWorkspaceTools,
  PRODUCT_WORKSPACE_TOOLS_OWNER,
} from "./product-tools-workspace.ts";
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
  AuthorizedProviderLoginPort,
  AuthorizedProviderLoginResult,
  ProviderConnectionAction,
  ProviderConnectionActionResult,
  ProviderConnectionHandoffResult,
  ProviderConnectionIssueCode,
  ProviderConnectionService,
  ProviderConnectionServicePorts,
  ProviderConnectionStorePort,
  ProviderConnectionStoreSnapshot,
  ProviderConnectionStoreWriteResult,
  ProviderConnectionView,
} from "./provider-connections.ts";
export { createProviderConnectionService } from "./provider-connections.ts";
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
  InspectedWorkspaceSession,
  InspectWorkspaceSessionError,
  InspectWorkspaceSessionInput,
  QueryWorkspaceSessionsInput,
} from "./session-catalog.ts";
export {
  editWorkspaceSessionCatalog,
  inspectWorkspaceSession,
  queryWorkspaceSessions,
} from "./session-catalog.ts";
export type { WorkspaceBinding } from "./session-isolation.ts";
export { isolateWorkspaceSessions } from "./session-isolation.ts";
export type { PlanWorkspaceSessionRecoveryInput } from "./session-recovery.ts";
export { planWorkspaceSessionRecovery } from "./session-recovery.ts";
export type { ControlWorkspaceSessionReplayInput } from "./session-replay-control.ts";
export { controlWorkspaceSessionReplay } from "./session-replay-control.ts";
export type { ResumeWorkspaceSessionInput } from "./session-resume.ts";
export { resumeWorkspaceSession } from "./session-resume.ts";
export type { RewindWorkspaceSessionInput } from "./session-rewind.ts";
export { rewindWorkspaceSession } from "./session-rewind.ts";
export type {
  OpenSessionInput,
  SessionCommandInput,
  SessionRuntime,
  SessionRuntimeError,
  SessionRuntimeResult,
} from "./session-runtime.ts";
export { createSessionRuntime } from "./session-runtime.ts";
export type {
  ProducerError,
  ProducerModelAttemptInput,
  ProducerResult,
  ProducerSessionInput,
  ProducerToolInvocationInput,
  ProducerTurnInput,
  SessionTurnTranscriptProducer,
  SessionTurnTranscriptProducerOptions,
} from "./session-turn-transcript-producer.ts";
export { createSessionTurnTranscriptProducer } from "./session-turn-transcript-producer.ts";
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
export { adviseOutcome } from "./task-advisor.ts";
export type {
  ExecuteOutcomeCommitPlanInput,
  ExecuteOutcomeCommitPlanResult,
  PlanOutcomeCommitsInput,
} from "./task-commit-plan.ts";
export {
  commitPlanConfirmToken,
  executeOutcomeCommitPlan,
  planOutcomeCommits,
} from "./task-commit-plan.ts";
export { decomposeOutcome } from "./task-decompose.ts";
export { planOutcomeTaskGraph } from "./task-graph.ts";
export { projectOutcomeProgress } from "./task-progress.ts";
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
  AttemptModelInput,
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
export type {
  WorkspaceLayoutStore,
  WorkspaceLayoutStoreError,
  WorkspaceLayoutUnusableRoot,
} from "./workspace-layout.ts";
export { createWorkspaceLayoutStore } from "./workspace-layout.ts";
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
export type {
  WorkspaceSetBinder,
  WorkspaceSetProbeError,
  WorkspaceSetResolveError,
  WorkspaceSetRootInput,
} from "./workspace-set.ts";
export { createWorkspaceSetBinder, resolveWorkspaceSet } from "./workspace-set.ts";
export type { WorkspaceWriter, WorkspaceWriterOptions } from "./workspace-write.ts";
export { createWorkspaceWriter } from "./workspace-write.ts";
