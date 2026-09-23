import { z } from "zod";
import {
  WORK_QUEUE_LIMITS,
  workEvidenceSchema,
  workFieldsSchema,
  workHolderSchema,
  workItemIdSchema,
  workQueueIdSchema,
  workReferenceSchema,
  workRevisionSchema,
  workScopeSchema,
} from "./work-queue.ts";

const update = workFieldsSchema
  .partial()
  .omit({ metadata: true })
  .extend({
    metadata: z
      .record(
        workReferenceSchema,
        z.union([z.string().max(16_384), z.number().finite(), z.boolean(), z.null()]),
      )
      .optional(),
  });
const item = { itemId: workItemIdSchema };
export const workMutationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), ...item, fields: workFieldsSchema }),
  z.strictObject({ kind: z.literal("update"), ...item, fields: update }),
  z.strictObject({ kind: z.enum(["link", "unlink"]), ...item, dependency: workItemIdSchema }),
  z.strictObject({
    kind: z.literal("blockers"),
    ...item,
    blockers: z.array(z.string().min(1).max(16_384)).max(100),
  }),
  z.strictObject({
    kind: z.literal("disposition"),
    ...item,
    value: z.enum(["pending", "ready", "active", "waiting", "blocked"]),
    reason: z.string().min(1).max(512),
  }),
  z.strictObject({ kind: z.literal("claim"), ...item, holder: workHolderSchema }),
  z.strictObject({
    kind: z.enum(["release", "reconcile", "cancel", "archive", "delete"]),
    ...item,
  }),
  z.strictObject({
    kind: z.literal("submit"),
    ...item,
    claimGeneration: workRevisionSchema,
    criteriaRevision: workRevisionSchema,
    evidence: z.array(workEvidenceSchema).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("validate"),
    ...item,
    itemRevision: workRevisionSchema,
    claimGeneration: workRevisionSchema,
    criteriaRevision: workRevisionSchema,
    evidence: z.array(workEvidenceSchema).min(1).max(100),
    authority: workReferenceSchema,
    verdict: z.enum(["accept", "refuse"]),
    reason: z.string().min(1).max(512),
  }),
]);
const provenance = {
  mutationId: workReferenceSchema,
  source: workReferenceSchema,
  sourceGeneration: workReferenceSchema,
  reason: z.string().min(1).max(512),
};
const selection = { queueId: workQueueIdSchema, scopeGeneration: workReferenceSchema };
const expected = { ...selection, expectedRevision: workRevisionSchema };
const subject = z.string().min(1).max(WORK_QUEUE_LIMITS.inlineBytes);
const nodeId = workItemIdSchema;
/** Siblings are addressed by ID; order keys are store-owned and never supplied. */
export const workPositionSchema = z.discriminatedUnion("at", [
  z.strictObject({ at: z.literal("end") }),
  z.strictObject({ at: z.literal("before"), sibling: nodeId }),
  z.strictObject({ at: z.literal("after"), sibling: nodeId }),
]);
export const workHierarchyMutationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("group"),
    groupId: nodeId,
    subject,
    parentId: nodeId.nullable(),
    position: workPositionSchema,
  }),
  z.strictObject({
    kind: z.literal("place"),
    nodeId,
    parentId: nodeId.nullable(),
    position: workPositionSchema,
  }),
  z.strictObject({ kind: z.literal("rename"), groupId: nodeId, subject }),
  z.strictObject({ kind: z.literal("remove-group"), groupId: nodeId }),
  z.strictObject({
    kind: z.literal("remove-subtree"),
    groupId: nodeId,
    /** The exact node set the caller reviewed; any difference refuses the removal. */
    reviewed: z.array(nodeId).min(1).max(WORK_QUEUE_LIMITS.batch),
  }),
]);
const HIERARCHY_KINDS: ReadonlySet<string> = new Set(
  workHierarchyMutationSchema.options.map((option) => option.shape.kind.value),
);
export function isHierarchyMutation(
  operation: WorkMutation | WorkHierarchyMutation,
): operation is WorkHierarchyMutation {
  return HIERARCHY_KINDS.has(operation.kind);
}
const page = { limit: z.int().min(1).max(WORK_QUEUE_LIMITS.page) };

function requestSchema<const Version extends 1 | 2, Mutation extends z.ZodType>(
  version: Version,
  mutation: Mutation,
) {
  const v = { version: z.literal(version) };
  return [
    z.strictObject({
      ...v,
      action: z.literal("create"),
      ...provenance,
      queueId: workQueueIdSchema,
      objective: z.string().min(1).max(16_384),
      scope: workScopeSchema,
    }),
    z.strictObject({
      ...v,
      action: z.literal("mutate"),
      ...provenance,
      ...expected,
      operations: z.array(mutation).min(1).max(WORK_QUEUE_LIMITS.batch),
    }),
    z.strictObject({ ...v, action: z.literal("show"), ...expected, itemId: workItemIdSchema }),
    z.strictObject({
      ...v,
      action: z.literal("list"),
      ...expected,
      after: workReferenceSchema.nullable(),
      ...page,
    }),
    z.strictObject({
      ...v,
      action: z.literal("edges"),
      ...expected,
      itemId: workItemIdSchema,
      direction: z.enum(["dependencies", "dependents"]),
      after: workReferenceSchema.nullable(),
      atRevision: workRevisionSchema.optional(),
    }),
    z.strictObject({
      ...v,
      action: z.literal("replay"),
      ...expected,
      atRevision: workRevisionSchema,
      after: workReferenceSchema.nullable(),
      ...page,
    }),
    z.strictObject({
      ...v,
      action: z.literal("history"),
      ...expected,
      afterRevision: workRevisionSchema,
      ...page,
    }),
    z.strictObject({
      ...v,
      action: z.literal("receipt"),
      ...selection,
      mutationId: workReferenceSchema,
    }),
    z.strictObject({ ...v, action: z.literal("resume") }),
  ] as const;
}

/** Version 2 adds groups and placement; version 1 clients keep a task-only view. */
export const workQueueRequestSchema = z.union([
  z.discriminatedUnion("action", requestSchema(1, workMutationSchema)),
  z.discriminatedUnion("action", [
    ...requestSchema(2, z.union([workMutationSchema, workHierarchyMutationSchema])),
    z.strictObject({ version: z.literal(2), action: z.literal("node"), ...expected, nodeId }),
    z.strictObject({ version: z.literal(2), action: z.literal("ancestors"), ...expected, nodeId }),
    z.strictObject({
      version: z.literal(2),
      action: z.literal("children"),
      ...expected,
      parentId: nodeId.nullable(),
      after: nodeId.nullable(),
      ...page,
    }),
    z.strictObject({
      version: z.literal(2),
      action: z.literal("subtree"),
      ...expected,
      groupId: nodeId,
      after: nodeId.nullable(),
      ...page,
    }),
    z.strictObject({
      version: z.literal(2),
      action: z.literal("progress"),
      ...expected,
      groupId: nodeId.nullable(),
      /** Continues a partial count; omitted or null starts at the beginning. */
      after: nodeId.nullable().optional(),
    }),
    z.strictObject({
      version: z.literal(2),
      action: z.literal("expand"),
      ...expected,
      groups: z.array(nodeId).max(256),
      tasks: z.array(nodeId).max(256),
    }),
    z.strictObject({
      version: z.literal(2),
      action: z.literal("removal-plan"),
      ...expected,
      groupId: nodeId,
    }),
  ]),
]);
export type WorkMutation = z.infer<typeof workMutationSchema>;
export type WorkHierarchyMutation = z.infer<typeof workHierarchyMutationSchema>;
export type WorkPosition = z.infer<typeof workPositionSchema>;
export type WorkQueueRequest = z.infer<typeof workQueueRequestSchema>;
