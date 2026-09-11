import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";
import { digestSchema, identityText } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import {
  processTaskArtifactSchema,
  processTaskHandleSchema,
  processTaskOwnerSchema,
} from "./process-task.ts";
import { resourceAmountsSchema } from "./resource-admission.ts";
import {
  WORKFLOW_LIMITS,
  workflowDefinitionSchema,
  workflowKeySchema,
} from "./workflow-definition.ts";

export const workflowHandleSchema = z.strictObject({
  id: workflowKeySchema,
  generation: workflowKeySchema,
});
export type WorkflowHandle = z.infer<typeof workflowHandleSchema>;
export const WORKFLOW_NODE_STATES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "timed-out",
  "uncertain",
] as const;
export const workflowNodeRecordSchema = z.strictObject({
  key: workflowKeySchema,
  template: workflowKeySchema,
  itemKey: z.string().max(128).nullable(),
  item: z.json(),
  state: z.enum(WORKFLOW_NODE_STATES),
  attempts: z.int().min(0).max(3),
  invocation: workflowKeySchema.nullable(),
  fingerprint: digestSchema.nullable(),
  result: processTaskArtifactSchema.nullable(),
  effect: z.enum(["none", "completed", "partial", "uncertain"]),
  reason: z.string().max(256).nullable(),
  question: processTaskHandleSchema.nullable(),
  observed: z.array(identityText).max(64),
  usage: resourceAmountsSchema,
  measured: resourceAmountsSchema.optional(),
  startedAt: z.int().nonnegative().nullable(),
  settledAt: z.int().nonnegative().nullable(),
});
export type WorkflowNodeRecord = z.infer<typeof workflowNodeRecordSchema>;
export const workflowRecordSchema = z.strictObject({
  version: z.literal(1),
  handle: workflowHandleSchema,
  revision: z.int().positive(),
  intent: digestSchema,
  definition: workflowDefinitionSchema,
  definitionDigest: digestSchema,
  arguments: z.json(),
  owner: processTaskOwnerSchema,
  authority: digestSchema,
  sourceGeneration: identityText,
  routes: z.record(workflowKeySchema, z.json()),
  createdAt: z.int().nonnegative(),
  deadline: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
  state: z.enum([
    "admitted",
    "running",
    "waiting",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "timed-out",
    "uncertain",
  ]),
  executor: identityText.nullable(),
  task: processTaskHandleSchema.nullable(),
  nodes: z.array(workflowNodeRecordSchema).max(WORKFLOW_LIMITS.nodes),
  expanded: z.array(workflowKeySchema).max(WORKFLOW_LIMITS.nodes),
  limits: resourceAmountsSchema,
  spent: resourceAmountsSchema,
  output: processTaskArtifactSchema.nullable(),
  reusedFrom: workflowHandleSchema.nullable(),
});
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;
export type WorkflowError = { readonly code: string; readonly currentRevision?: number };
export type WorkflowResult<T> = Result<T, WorkflowError>;
export type WorkflowStore = {
  create(record: WorkflowRecord, signal?: AbortSignal): WorkflowResult<WorkflowRecord>;
  get(handle: WorkflowHandle, atRevision?: number): WorkflowResult<WorkflowRecord>;
  change(
    handle: WorkflowHandle,
    expectedRevision: number,
    update: (record: WorkflowRecord) => WorkflowResult<WorkflowRecord>,
    signal?: AbortSignal,
  ): WorkflowResult<WorkflowRecord>;
  page(
    workspaceId: string,
    sessionId: string,
    after?: WorkflowHandle,
  ): WorkflowResult<readonly WorkflowReceipt[]>;
};
export const workflowReceiptSchema = z.strictObject({
  version: z.literal(1),
  handle: workflowHandleSchema,
  revision: z.int().positive(),
  digest: digestSchema,
  definitionDigest: digestSchema,
  state: workflowRecordSchema.shape.state,
  at: z.int().nonnegative(),
});
export type WorkflowReceipt = z.infer<typeof workflowReceiptSchema>;

/** Checkpoint updates cannot reopen observed terminal work or replace a stable node. */
export function validWorkflowTransition(previous: WorkflowRecord, next: WorkflowRecord): boolean {
  const terminal = ["completed", "failed", "cancelled", "timed-out", "uncertain"];
  if (terminal.includes(previous.state) && next.state !== previous.state) return false;
  if (previous.expanded.some((key) => !next.expanded.includes(key))) return false;
  const transitions: Record<WorkflowNodeRecord["state"], readonly WorkflowNodeRecord["state"][]> = {
    pending: ["pending", "running", "completed", "failed", "skipped", "cancelled"],
    running: [
      "running",
      "pending",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "timed-out",
      "uncertain",
    ],
    waiting: ["waiting", "completed", "failed", "cancelled", "timed-out", "uncertain"],
    completed: ["completed"],
    failed: ["failed"],
    skipped: ["skipped"],
    cancelled: ["cancelled"],
    "timed-out": ["timed-out"],
    uncertain: ["uncertain"],
  };
  for (const prior of previous.nodes) {
    const node = next.nodes.find((node) => node.key === prior.key);
    if (
      !node ||
      !transitions[prior.state].includes(node.state) ||
      node.attempts < prior.attempts ||
      node.attempts > prior.attempts + 1 ||
      node.template !== prior.template ||
      node.itemKey !== prior.itemKey ||
      canonicalDigest(node.item) !== canonicalDigest(prior.item)
    )
      return false;
    if (
      !["pending", "running", "waiting"].includes(prior.state) &&
      canonicalDigest(node) !== canonicalDigest(prior)
    )
      return false;
    if (
      prior.state === "pending" &&
      node.state === "completed" &&
      (node.attempts !== 0 || node.reason !== "workflow-result-reused")
    )
      return false;
  }
  return true;
}
