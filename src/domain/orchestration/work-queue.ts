/** Work records describe intent and evidence; they never acquire execution authority. */
import { z } from "zod";
import type { Result } from "../foundation/result.ts";

export const WORK_QUEUE_LIMITS = {
  batch: 100,
  page: 100,
  inlineBytes: 16_384,
  recordBytes: 32_768,
  requestBytes: 1_048_576,
  responseBytes: 1_048_576,
  validationMs: 30_000,
  traversalSteps: 10_000,
  /** Hierarchy input and traversal ceiling; a root-level node is at depth 1. */
  depth: 32,
} as const;
export const workReferenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/u);
export const workQueueIdSchema = workReferenceSchema.brand<"WorkQueueId">();
export const workItemIdSchema = workReferenceSchema.brand<"WorkItemId">();
export type WorkQueueId = z.infer<typeof workQueueIdSchema>;
export type WorkItemId = z.infer<typeof workItemIdSchema>;
export const workRevisionSchema = z
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = z.string().max(WORK_QUEUE_LIMITS.inlineBytes);
const names = z.array(workReferenceSchema).max(100);
export const workScopeSchema = z.strictObject({
  kind: z.enum(["memory", "session", "session-global", "project", "shared"]),
  generation: workReferenceSchema,
  configurationGeneration: workRevisionSchema,
  workspaceId: workReferenceSchema,
  sessionId: workReferenceSchema.nullable(),
  owner: workReferenceSchema,
  members: names,
  locator: workReferenceSchema,
});
export type WorkScope = z.infer<typeof workScopeSchema>;
export const workQueueSchema = z.strictObject({
  version: z.literal(1),
  id: workQueueIdSchema,
  revision: workRevisionSchema,
  scope: workScopeSchema,
  objective: text.min(1),
  createdAt: workRevisionSchema,
  updatedAt: workRevisionSchema,
});
export type WorkQueue = z.infer<typeof workQueueSchema>;
export const WORK_DISPOSITIONS = [
  "pending",
  "ready",
  "active",
  "waiting",
  "blocked",
  "completion-claimed",
  "completed",
  "cancelled",
  "archived",
] as const;
export const workHolderSchema = z.strictObject({
  taskId: workReferenceSchema,
  generation: workReferenceSchema,
  actor: workReferenceSchema,
});
export const workClaimSchema = z.strictObject({
  generation: workRevisionSchema,
  holder: workHolderSchema,
  releasePending: z.boolean(),
});
export const workEvidenceSchema = z.strictObject({
  handle: workReferenceSchema,
  generation: workReferenceSchema,
  source: workReferenceSchema,
});
export const workExecutionSchema = z.strictObject({
  id: workReferenceSchema,
  generation: workReferenceSchema,
  state: z.enum(["active", "uncertain", "settled", "fenced"]),
});
export const workFieldsSchema = z.strictObject({
  subject: text.min(1),
  description: text,
  objective: text.min(1),
  activeForm: text.nullable(),
  agentType: workReferenceSchema.nullable(),
  metadata: z
    .record(workReferenceSchema, z.union([text, z.number().finite(), z.boolean()]))
    .refine((v) => Object.keys(v).length <= 100),
  criteria: z.array(text.min(1)).min(1).max(100),
});
export type WorkFields = z.infer<typeof workFieldsSchema>;
export const workItemSchema = workFieldsSchema.extend({
  version: z.literal(1),
  id: workItemIdSchema,
  queueId: workQueueIdSchema,
  revision: workRevisionSchema,
  criteriaRevision: workRevisionSchema,
  disposition: z.enum(WORK_DISPOSITIONS),
  previousDisposition: z.enum(WORK_DISPOSITIONS).nullable(),
  reason: text.nullable(),
  blockers: z.array(text.min(1)).max(100),
  unresolvedDependencies: z.boolean(),
  claimGeneration: workRevisionSchema,
  claim: workClaimSchema.nullable(),
  execution: workExecutionSchema.nullable(),
  evidence: z.array(workEvidenceSchema).max(100),
  acceptance: z
    .strictObject({
      actor: workReferenceSchema,
      authority: workReferenceSchema,
      reason: text,
      criteriaRevision: workRevisionSchema,
    })
    .nullable(),
  deleted: z.boolean(),
  createdAt: workRevisionSchema,
  updatedAt: workRevisionSchema,
});
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkEdge = { readonly item: WorkItemId; readonly dependency: WorkItemId };
/**
 * A named heading that organizes tasks. It has no criteria, claim, execution or
 * acceptance: it cannot be claimed, run, depended on or completed directly.
 */
export const workGroupSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("group"),
  id: workItemIdSchema,
  queueId: workQueueIdSchema,
  revision: workRevisionSchema,
  subject: text.min(1),
  source: workReferenceSchema,
  sourceGeneration: workReferenceSchema,
  actor: workReferenceSchema,
  deleted: z.boolean(),
  createdAt: workRevisionSchema,
  updatedAt: workRevisionSchema,
});
export type WorkGroup = z.infer<typeof workGroupSchema>;
/**
 * Where a node sits: a single-parent forest with ordered siblings. A task with
 * no recorded placement is a root node ordered by its ID, which is the order
 * flat queues always had. Order keys are opaque and store-owned.
 */
export type WorkPlacement = { readonly parent: WorkItemId | null; readonly order: string };
export type WorkChild = { readonly id: WorkItemId; readonly order: string };
const digestText = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptV1 = {
  queueId: workQueueIdSchema,
  scopeGeneration: workReferenceSchema,
  mutationId: workReferenceSchema,
  intent: digestText,
  queueDigest: digestText,
  edgesDigest: digestText,
  previousRevision: workRevisionSchema,
  revision: workRevisionSchema,
  actor: workReferenceSchema,
  source: workReferenceSchema,
  sourceGeneration: workReferenceSchema,
  reason: z.string().max(512),
  at: workRevisionSchema,
  items: z.array(z.strictObject({ id: workItemIdSchema, digest: digestText })).max(100),
};
/**
 * Version 1 receipts cover flat task changes. A mutation that creates or changes
 * a group or a placement writes version 2, which also binds group records and
 * the placement rows written at its revision.
 */
export const workReceiptSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(1), ...receiptV1 }),
  z.strictObject({
    version: z.literal(2),
    ...receiptV1,
    groups: z.array(z.strictObject({ id: workItemIdSchema, digest: digestText })).max(100),
    placementsDigest: digestText,
    /** Groups whose derived progress may have changed; `complete` false means invalidate all. */
    affected: z.strictObject({
      groups: z.array(workItemIdSchema).max(64),
      complete: z.boolean(),
    }),
  }),
]);
export type WorkReceipt = z.infer<typeof workReceiptSchema>;
export type WorkQueueError = {
  readonly code:
    | "malformed"
    | "unsupported"
    | "unavailable"
    | "denied"
    | "cancelled-operation"
    | "conflicting-revision"
    | "conflicting-identity"
    | "invalid-dependency"
    | "invalid-hierarchy"
    | "blocked-transition"
    | "stale-evidence"
    | "stale-page"
    | "resource-exhausted"
    | "corrupt"
    | "recovery-required";
  readonly currentRevision?: number;
  readonly dimension?:
    | "requestBytes"
    | "responseBytes"
    | "inlineBytes"
    | "validation"
    | "storage"
    | "admission";
  readonly incomplete?: boolean;
  /** Original accepted source remains with its owner; refusal never claims these effects completed. */
  readonly source?: string;
  readonly sourceGeneration?: string;
};
export type WorkResult<T> = Result<T, WorkQueueError>;
/** Throwing aborts the entire transaction, including earlier operations in a batch. */
export class WorkQueueRefusal extends Error {
  constructor(readonly failure: WorkQueueError) {
    super(failure.code);
  }
}
export function refuseWork(
  code: WorkQueueError["code"],
  detail: Omit<WorkQueueError, "code"> = {},
): never {
  throw new WorkQueueRefusal({ code, ...detail });
}
export interface WorkQueueTransaction {
  queue(id: WorkQueueId): WorkQueue | null;
  queueAt(id: WorkQueueId, revision: number): WorkQueue | null;
  putQueue(queue: WorkQueue): void;
  item(queue: WorkQueueId, item: WorkItemId): WorkItem | null;
  putItem(item: WorkItem): void;
  items(queue: WorkQueueId, after: string, limit: number): readonly WorkItem[];
  itemsAt(queue: WorkQueueId, revision: number, after: string, limit: number): readonly WorkItem[];
  edges(
    queue: WorkQueueId,
    item: WorkItemId,
    direction: "dependencies" | "dependents",
    after: string,
    revision?: number,
  ): readonly WorkItemId[];
  setEdge(queue: WorkQueueId, edge: WorkEdge, present: boolean): void;
  group(queue: WorkQueueId, group: WorkItemId): WorkGroup | null;
  putGroup(group: WorkGroup): void;
  /** The recorded placement, or null for a task that is implicitly a root node. */
  placement(queue: WorkQueueId, node: WorkItemId): WorkPlacement | null;
  setPlacement(queue: WorkQueueId, node: WorkItemId, placement: WorkPlacement): void;
  /** Ordered by opaque key then ID, including tombstoned nodes; callers skip those. */
  children(
    queue: WorkQueueId,
    parent: WorkItemId | null,
    after: WorkChild | null,
    limit: number,
    direction?: "forward" | "backward",
  ): readonly WorkChild[];
  placementsDigest(queue: WorkQueueId, revision: number): string;
  receipt(queue: WorkQueueId, mutation: string): WorkReceipt | null;
  appendReceipt(queue: WorkQueue, receipt: WorkReceipt): void;
  edgesDigest(queue: WorkQueueId, revision: number): string;
  history(queue: WorkQueueId, afterRevision: number, limit: number): readonly WorkReceipt[];
  binding(session: string, workspace: string): WorkQueueId | null;
  bind(session: string, workspace: string, queue: WorkQueueId): void;
}
export interface WorkQueueStore {
  readonly locator: string;
  readonly durability: "ephemeral" | "durable";
  transaction<T>(work: (tx: WorkQueueTransaction) => T, signal?: AbortSignal): WorkResult<T>;
}

/** Host-owned authorization and observations, never decoded from mutation metadata. */
export interface WorkQueueAuthority {
  readonly actor: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly persistentSession: boolean;
  authorize(queue: WorkQueue, operation: "read" | "create" | "mutate"): boolean;
  registeredAgent(type: string): boolean;
  sourceAvailable(handle: string, generation: string): boolean;
  admitHolder(holder: z.infer<typeof workHolderSchema>): boolean;
  observeExecution(item: WorkItem): z.infer<typeof workExecutionSchema> | null;
  validateCompletion(input: {
    queue: WorkQueue;
    item: WorkItem;
    authority: string;
    verdict: "accept" | "refuse";
    reason: string;
  }): boolean;
}
