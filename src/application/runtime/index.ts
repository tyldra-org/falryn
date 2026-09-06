/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  InterruptionDecision,
  InterruptionPolicy,
  InterruptionState,
} from "./interruption.ts";
export { attachInterruptionPolicy, createInterruptionPolicy } from "./interruption.ts";
export type { MidTurnInputService, MidTurnInputServiceOptions } from "./mid-turn-input.ts";
export { createMidTurnInputService, describeMidTurnClassifyError } from "./mid-turn-input.ts";
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
export type {
  ProductExecutionProfileControls,
  ProductExecutionProfileSelection,
  ProductLiveTurnExecutor,
  ProductLiveTurnExecutorOptions,
  ProductLiveTurnInput,
  ProductLiveTurnResult,
  ProductModelSelection,
  ProductModelSelectionControls,
} from "./product-live-turn.ts";
export { createProductLiveTurnExecutor, productModelPolicy } from "./product-live-turn.ts";
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
