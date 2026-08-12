/**
 * The application layer's public entrypoint.
 *
 * Outer layers depend on this file, never on individual modules inside it. The
 * layer depends on `src/domain` and on nothing further out.
 */

export type {
  BoundedQueue,
  BoundedQueueOptions,
  EnqueueRequest,
} from "./bounded-queue.ts";
export { createBoundedQueue } from "./bounded-queue.ts";
export type { BudgetLedger } from "./budget-ledger.ts";
export { createBudgetLedger, MAX_BUDGET_DEPTH } from "./budget-ledger.ts";
export type { SecretResolverOptions } from "./credential-resolver.ts";
export { createSecretResolver } from "./credential-resolver.ts";
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
  InterruptionDecision,
  InterruptionPolicy,
  InterruptionState,
} from "./interruption.ts";
export { attachInterruptionPolicy, createInterruptionPolicy } from "./interruption.ts";
export type {
  DigestedPromptRequest,
  PromptComposer,
  PromptComposerError,
  PromptComposerOptions,
  PromptComposerResult,
} from "./prompt-composer.ts";
export { createPromptComposer } from "./prompt-composer.ts";
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
  StartTurnInput,
  TurnCommandInput,
  TurnCoordinator,
  TurnCoordinatorError,
  TurnCoordinatorResult,
} from "./turn-coordinator.ts";
export { createTurnCoordinator } from "./turn-coordinator.ts";
