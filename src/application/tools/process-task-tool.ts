/** Strict, non-launching process task controls using the existing tool registry. */
import { z } from "zod";
import {
  MAX_PROCESS_TASK_LOG_BYTES,
  MAX_PROCESS_TASK_RESPONSE_BYTES,
  MAX_PROCESS_TASK_WAIT_MS,
  processTaskControlSchema,
  processTaskHandleSchema,
  processTaskReceiptSchema,
} from "../../domain/orchestration/process-task.ts";
import { conflictKey } from "../../domain/orchestration/work.ts";
import {
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";

export const PROCESS_TASK_CONTROL_CAPABILITY = "builtin:workspace/process_task@1";
const operation = z.enum([
  "inspect",
  "logs",
  "result",
  "wait",
  "detach",
  "reattach",
  "cancel",
  "kill",
  "cleanup",
]);

// Provider function parameters have an object root. The domain union remains the
// authority for operation-specific fields, so irrelevant fields are still refused.
const inputSchema = z
  .strictObject({
    ...processTaskHandleSchema.shape,
    operation,
    stream: z.enum(["stdout", "stderr"]).optional().describe("Required only for logs."),
    offset: z.int().nonnegative().optional().describe("Required for logs; optional for result."),
    limit: z
      .int()
      .min(1)
      .max(MAX_PROCESS_TASK_LOG_BYTES)
      .optional()
      .describe("Required for logs; optional for result."),
    waitMs: z
      .int()
      .min(1)
      .max(MAX_PROCESS_TASK_WAIT_MS)
      .optional()
      .describe("Required only for wait."),
    expectedRevision: z
      .int()
      .positive()
      .optional()
      .describe("Required only for detach, reattach, cancel, kill, and cleanup."),
  })
  .superRefine((input, context) => {
    if (!processTaskControlSchema.safeParse(input).success)
      context.addIssue({
        code: "custom",
        message: "fields do not match the requested task operation",
      });
  });

export const processTaskControlOutputSchema = z.union([
  processTaskReceiptSchema,
  z.strictObject({
    kind: z.literal("process-task-read"),
    task: processTaskReceiptSchema,
    source: z.enum(["stdout", "stderr", "result"]),
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
    redacted: z.boolean(),
    exact: z.boolean(),
    byteLength: z.int().nonnegative(),
    offset: z.int().nonnegative(),
    nextOffset: z.int().nonnegative(),
    availableBytes: z.int().nonnegative(),
    durableBytes: z.int().nonnegative(),
    sealed: z.boolean(),
    complete: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("process-task-cleaned"), handle: processTaskHandleSchema }),
  z.strictObject({
    kind: z.literal("process-task-stop-requested"),
    operation: z.enum(["cancel", "kill"]),
    task: processTaskReceiptSchema,
  }),
]);

export function createProcessTaskToolEntry() {
  const registered = createToolRegistryEntry(
    {
      namespace: "workspace",
      name: "process_task",
      version: 1,
      source: "builtin",
      title: "Control a captured process task",
      description:
        "Inspect an existing task, read bounded logs or a sealed result, wait, detach, reattach, cancel, kill, or clean up. Never launches work. Use the exact handle and current revision from its receipt. Waiting does not cancel a task; settlement never starts a model turn.",
      effect: "mutation",
      capabilityKind: "process",
      platforms: [],
      limits: defaultToolLimits({
        defaultTimeoutMs: MAX_PROCESS_TASK_WAIT_MS + 1_000,
        maxOutputBytes: MAX_PROCESS_TASK_RESPONSE_BYTES,
      }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({
        modelMaxBytes: MAX_PROCESS_TASK_RESPONSE_BYTES,
      }),
    },
    {
      inputSchema,
      outputSchema: processTaskControlOutputSchema,
      effectFor: (input) =>
        ["inspect", "logs", "result", "wait"].includes(String(input.operation))
          ? "observation"
          : "mutation",
      // Controlling one owned tree does not acquire the held workspace-effect lock.
      conflictKeysFor: (input) => [
        conflictKey("process-task-control", `${String(input.taskId)}:${String(input.generation)}`),
      ],
    },
  );
  if (!registered.ok) throw new Error(`process task registration failed: ${registered.error.code}`);
  return registered.value;
}
