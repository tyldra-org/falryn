import type {
  ProcessTaskHandle,
  ProcessTaskOwner,
} from "../../domain/orchestration/process-task.ts";
import type { ResourceAmounts } from "../../domain/orchestration/resource-admission.ts";
import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowNode,
} from "../../domain/orchestration/workflow-definition.ts";
import type {
  WorkflowNodeRecord,
  WorkflowRecord,
} from "../../domain/orchestration/workflow-state.ts";
import type { ProductTaskResources } from "./product-resources.ts";

export type WorkflowNodeOutcome = {
  readonly state: "completed" | "failed" | "cancelled" | "timed-out" | "uncertain" | "waiting";
  readonly effect: "none" | "completed" | "partial" | "uncertain";
  readonly value?: unknown;
  readonly reason?: string;
  readonly question?: ProcessTaskHandle;
  readonly observations?: readonly string[];
  /** Only measured dimensions may reconcile a pre-effect reservation. */
  readonly usage?: ResourceAmounts;
  /** Existing native result references suitable for work-item evidence submission. */
  readonly evidence?: readonly { handle: string; generation: string; source: string }[];
};
/** Live authority and effect owners are injected by the application host, never read from JSON. */
export type WorkflowHost = {
  readonly owner: ProcessTaskOwner;
  readonly resources: ProductTaskResources;
  readonly authority: string;
  readonly sourceGeneration: string;
  current(record: WorkflowRecord): boolean;
  validate(definition: WorkflowDefinition): readonly WorkflowDiagnostic[];
  routes(definition: WorkflowDefinition): WorkflowRecord["routes"];
  reservation(node: WorkflowNode, record: WorkflowRecord): ResourceAmounts | null;
  execute(
    node: WorkflowNode,
    input: Readonly<Record<string, unknown>>,
    record: WorkflowRecord,
    instance: WorkflowNodeRecord,
    resources: ProductTaskResources,
    signal: AbortSignal,
  ): Promise<WorkflowNodeOutcome>;
  question(
    instance: WorkflowNodeRecord,
    record: WorkflowRecord,
    signal: AbortSignal,
  ): Promise<WorkflowNodeOutcome>;
  /** Waits on native settlement notifications, never on model polling. */
  wait?(record: WorkflowRecord, signal: AbortSignal): Promise<void>;
  fenced(task: ProcessTaskHandle | null): Promise<boolean>;
  reusable(
    node: WorkflowNode,
    prior: WorkflowNodeRecord,
    record: WorkflowRecord,
    signal: AbortSignal,
  ): Promise<boolean>;
};
