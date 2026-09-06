/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  BoundedQueue,
  BoundedQueueOptions,
  EnqueueRequest,
} from "./bounded-queue.ts";
export { createBoundedQueue } from "./bounded-queue.ts";
export type { BudgetLedger } from "./budget-ledger.ts";
export { createBudgetLedger, MAX_BUDGET_DEPTH } from "./budget-ledger.ts";
export type { ProductOpportunityPlanOptions } from "./product-opportunity-plan.ts";
export {
  createProductOpportunityPlan,
  productOpportunityIntentFamilies,
} from "./product-opportunity-plan.ts";
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
