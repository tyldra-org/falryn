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
export const workQueueRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    version: z.literal(1),
    action: z.literal("create"),
    ...provenance,
    queueId: workQueueIdSchema,
    objective: z.string().min(1).max(16_384),
    scope: workScopeSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("mutate"),
    ...provenance,
    ...expected,
    operations: z.array(workMutationSchema).min(1).max(WORK_QUEUE_LIMITS.batch),
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("show"),
    ...expected,
    itemId: workItemIdSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("list"),
    ...expected,
    after: workReferenceSchema.nullable(),
    limit: z.int().min(1).max(WORK_QUEUE_LIMITS.page),
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("edges"),
    ...expected,
    itemId: workItemIdSchema,
    direction: z.enum(["dependencies", "dependents"]),
    after: workReferenceSchema.nullable(),
    atRevision: workRevisionSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("replay"),
    ...expected,
    atRevision: workRevisionSchema,
    after: workReferenceSchema.nullable(),
    limit: z.int().min(1).max(WORK_QUEUE_LIMITS.page),
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("history"),
    ...expected,
    afterRevision: workRevisionSchema,
    limit: z.int().min(1).max(WORK_QUEUE_LIMITS.page),
  }),
  z.strictObject({
    version: z.literal(1),
    action: z.literal("receipt"),
    ...selection,
    mutationId: workReferenceSchema,
  }),
  z.strictObject({ version: z.literal(1), action: z.literal("resume") }),
]);
export type WorkMutation = z.infer<typeof workMutationSchema>;
export type WorkQueueRequest = z.infer<typeof workQueueRequestSchema>;
