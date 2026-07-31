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
export type {
  InterruptionDecision,
  InterruptionPolicy,
  InterruptionState,
} from "./interruption.ts";
export { attachInterruptionPolicy, createInterruptionPolicy } from "./interruption.ts";
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
  ScopeHandle,
  ScopeTree,
  ScopeTreeOptions,
} from "./scope-tree.ts";
export { createScopeTree, MAX_LIVE_SCOPES, MAX_SCOPE_DEPTH } from "./scope-tree.ts";
export type {
  ShutdownCoordinator,
  ShutdownCoordinatorOptions,
  ShutdownOptions,
} from "./shutdown-coordinator.ts";
export { createShutdownCoordinator } from "./shutdown-coordinator.ts";
