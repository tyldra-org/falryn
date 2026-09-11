/** Immutable selection for the task-list consumer; execution remains owned by workflows. */
import { z } from "zod";
import {
  workFieldsSchema,
  workItemIdSchema,
  workQueueSchema,
  workReferenceSchema,
  workRevisionSchema,
} from "./work-queue.ts";

export const taskListSelectionSchema = z.strictObject({
  queue: workQueueSchema,
  autoCascade: z.boolean().default(false),
  source: workReferenceSchema,
  sourceGeneration: workReferenceSchema,
  items: z
    .array(
      workFieldsSchema.extend({
        id: workItemIdSchema,
        criteriaRevision: workRevisionSchema,
        dependencies: z.array(workItemIdSchema).max(100),
        node: z.string().min(1).max(128).nullable(),
      }),
    )
    .min(1)
    .max(256),
});
export type TaskListSelection = z.infer<typeof taskListSelectionSchema>;
