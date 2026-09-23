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
  /**
   * Present when groups were expanded: the queue revision they were resolved at,
   * the groups selected and what was not admitted. Later moves or additions do
   * not alter a frozen selection.
   */
  hierarchy: z
    .strictObject({
      revision: workRevisionSchema,
      groups: z.array(workItemIdSchema).max(256),
      excluded: z.strictObject({
        accepted: z.int().nonnegative(),
        archived: z.int().nonnegative(),
        cancelled: z.int().nonnegative(),
        blocked: z.array(workItemIdSchema).max(256),
        unavailable: z.array(workItemIdSchema).max(256),
      }),
    })
    .optional(),
});
export type TaskListSelection = z.infer<typeof taskListSelectionSchema>;
