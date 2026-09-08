/** Captured-process task contracts. Launch inputs and output bytes are never task metadata. */
import { z } from "zod";
import {
  type ProcessBirthIdentity,
  processBirthIdentitySchema,
} from "../process/process-identity.ts";
import { EFFECT_CERTAINTIES, TERMINAL_OUTCOME_KINDS } from "./outcome.ts";

export const MAX_RETAINED_PROCESS_TASKS = 256;
export const MAX_PROCESS_TASK_WAITERS = 64;
export const MAX_PROCESS_TASK_WAIT_MS = 30_000;
export const DEFAULT_PROCESS_TASK_WAIT_MS = 1_000;
export const PROCESS_TASK_LEASE_MS = 15_000;
export const PROCESS_TASK_LEASE_RENEWAL_MS = 5_000;
export const MAX_PROCESS_TASK_WAKE_ATTEMPTS = 3;
export const MAX_PROCESS_TASK_LOG_BYTES = 32 * 1_024;
export const MAX_PROCESS_TASK_RESPONSE_BYTES = 64 * 1_024;

const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const revision = z.int().min(1);
const timestamp = z.int().nonnegative();

export const processTaskExecutionSchema = z.strictObject({
  version: z.literal(1),
  attachment: z.enum(["foreground", "background"]),
  foregroundWaitMs: z
    .int()
    .min(1)
    .max(MAX_PROCESS_TASK_WAIT_MS)
    .default(DEFAULT_PROCESS_TASK_WAIT_MS),
  onSettle: z.literal("notify"),
  shutdown: z.literal("drain"),
});
export type ProcessTaskExecution = z.infer<typeof processTaskExecutionSchema>;

export const processTaskHandleSchema = z.strictObject({
  version: z.literal(1),
  taskId: identity,
  generation: identity,
});
export type ProcessTaskHandle = z.infer<typeof processTaskHandleSchema>;

export const processTaskOwnerSchema = z.strictObject({
  sessionId: identity,
  workspaceId: identity,
  turnId: identity,
  invocationId: identity,
  attemptId: identity,
  configurationGeneration: z.int().nonnegative(),
  resourceTaskId: identity,
});
export type ProcessTaskOwner = z.infer<typeof processTaskOwnerSchema>;

export const processTaskSupervisorSchema = z.strictObject({
  runId: identity,
  process: processBirthIdentitySchema,
  leaseExpiresAt: timestamp,
});
export type ProcessTaskSupervisor = z.infer<typeof processTaskSupervisorSchema>;

export const processTaskArtifactSchema = z.strictObject({
  artifactId: identity,
  digest: z.string().regex(/^sha-256:[a-f0-9]{64}$/),
  byteLength: z.int().nonnegative(),
});
export type ProcessTaskArtifact = z.infer<typeof processTaskArtifactSchema>;

export const processTaskTerminalSchema = z
  .strictObject({
    outcome: z.enum(TERMINAL_OUTCOME_KINDS),
    effect: z.enum(EFFECT_CERTAINTIES),
    reason: z.enum([
      "exited",
      "spawn-failed",
      "cancelled",
      "timed-out",
      "capture-exceeded",
      "persistence-unavailable",
      "unconfirmed-exit",
      "supervisor-vanished",
      "supervisor-replaced",
      "supervisor-unreachable",
      "ownership-uncertain",
    ]),
    exitCode: z.int().nullable(),
    signal: identity.nullable(),
    sealedAt: timestamp,
    result: processTaskArtifactSchema.nullable(),
    outputComplete: z.boolean().optional(),
  })
  .refine((terminal) => {
    if (terminal.outcome === "uncertain") return terminal.effect === "uncertain";
    if (terminal.outcome !== "completed") return true;
    return (
      terminal.effect === "completed" &&
      terminal.reason === "exited" &&
      terminal.exitCode === 0 &&
      terminal.signal === null &&
      terminal.result !== null
    );
  }, "terminal outcome contradicts process evidence");
export type ProcessTaskTerminal = z.infer<typeof processTaskTerminalSchema>;

const common = {
  handle: processTaskHandleSchema,
  revision,
  owner: processTaskOwnerSchema,
  supervisor: processTaskSupervisorSchema,
  attachment: z.enum(["foreground", "background"]),
  createdAt: timestamp,
  deadline: timestamp,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outputMode: z.enum(["raw", "hush"]),
};

/** Each semantic task transition persists this bounded, output-free snapshot. */
export const processTaskSnapshotSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      ...common,
      state: z.literal("queued"),
      process: z.null(),
      terminal: z.null(),
    }),
    z.strictObject({
      ...common,
      state: z.literal("running"),
      process: processBirthIdentitySchema,
      terminal: z.null(),
    }),
    z.strictObject({
      ...common,
      state: z.literal("settling"),
      process: processBirthIdentitySchema.nullable(),
      terminal: z.null(),
    }),
    z.strictObject({
      ...common,
      state: z.literal("terminal"),
      process: processBirthIdentitySchema.nullable(),
      terminal: processTaskTerminalSchema,
    }),
  ])
  .refine(
    (task) =>
      task.deadline >= task.createdAt &&
      (task.state !== "terminal" ||
        (task.terminal.sealedAt >= task.createdAt &&
          (task.terminal.outcome !== "completed" || task.process !== null))),
    "task lifecycle contradicts process evidence",
  );
export type ProcessTaskSnapshot = z.infer<typeof processTaskSnapshotSchema>;

export const processTaskReceiptSchema = z.strictObject({
  kind: z.literal("process-task-receipt"),
  handle: processTaskHandleSchema,
  revision,
  owner: processTaskOwnerSchema,
  attachment: common.attachment,
  state: z.enum(["queued", "running", "settling", "terminal"]),
  deadline: timestamp,
  terminal: processTaskTerminalSchema.nullable(),
  notification: z
    .strictObject({
      state: z.enum(["pending", "acknowledged", "unavailable"]),
      attempts: z.int().min(0).max(3),
      notificationId: z.string().min(1).max(256),
    })
    .optional(),
  controls: z
    .array(
      z.enum([
        "inspect",
        "logs",
        "result",
        "wait",
        "detach",
        "reattach",
        "cancel",
        "kill",
        "cleanup",
      ]),
    )
    .max(9),
});
export type ProcessTaskReceipt = z.infer<typeof processTaskReceiptSchema>;

export function processTaskReceipt(task: ProcessTaskSnapshot): ProcessTaskReceipt {
  return {
    kind: "process-task-receipt",
    handle: task.handle,
    revision: task.revision,
    owner: task.owner,
    attachment: task.attachment,
    state: task.state,
    deadline: task.deadline,
    terminal: task.terminal,
    controls: [
      "inspect",
      "logs",
      "result",
      "wait",
      "detach",
      "reattach",
      "cancel",
      "kill",
      "cleanup",
    ],
  };
}

const control = { ...processTaskHandleSchema.shape };
export const processTaskControlSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...control, operation: z.literal("inspect") }),
  z.strictObject({
    ...control,
    operation: z.literal("logs"),
    stream: z.enum(["stdout", "stderr"]),
    offset: z.int().nonnegative(),
    limit: z.int().min(1).max(MAX_PROCESS_TASK_LOG_BYTES),
  }),
  z.strictObject({
    ...control,
    operation: z.literal("result"),
    offset: z.int().nonnegative().default(0),
    limit: z.int().min(1).max(MAX_PROCESS_TASK_LOG_BYTES).default(MAX_PROCESS_TASK_LOG_BYTES),
  }),
  z.strictObject({
    ...control,
    operation: z.literal("wait"),
    waitMs: z.int().min(1).max(MAX_PROCESS_TASK_WAIT_MS),
  }),
  z.strictObject({ ...control, operation: z.literal("detach"), expectedRevision: revision }),
  z.strictObject({ ...control, operation: z.literal("reattach"), expectedRevision: revision }),
  z.strictObject({ ...control, operation: z.literal("cancel"), expectedRevision: revision }),
  z.strictObject({ ...control, operation: z.literal("kill"), expectedRevision: revision }),
  z.strictObject({ ...control, operation: z.literal("cleanup"), expectedRevision: revision }),
]);
export type ProcessTaskControl = z.infer<typeof processTaskControlSchema>;

export type ProcessTaskTransition =
  | { readonly kind: "started"; readonly process: ProcessBirthIdentity }
  | { readonly kind: "attachment"; readonly attachment: ProcessTaskExecution["attachment"] }
  | { readonly kind: "settling" }
  | { readonly kind: "sealed"; readonly terminal: ProcessTaskTerminal };

export type ProcessTaskFence = {
  readonly handle: ProcessTaskHandle;
  readonly supervisorRunId: string;
  readonly expectedRevision: number;
};
export type ProcessTaskTransitionResult =
  | { readonly ok: true; readonly value: ProcessTaskSnapshot }
  | {
      readonly ok: false;
      readonly code:
        | "stale-generation"
        | "stale-revision"
        | "ownership-unavailable"
        | "invalid-transition"
        | "sealed";
    };

/** Apply only inside the storage transaction that owns the current snapshot. */
export function transitionProcessTask(
  current: ProcessTaskSnapshot,
  fence: ProcessTaskFence,
  change: ProcessTaskTransition,
  now: number,
): ProcessTaskTransitionResult {
  if (
    current.handle.taskId !== fence.handle.taskId ||
    current.handle.generation !== fence.handle.generation
  )
    return { ok: false, code: "stale-generation" };
  if (current.revision !== fence.expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER)
    return { ok: false, code: "stale-revision" };
  if (
    current.supervisor.runId !== fence.supervisorRunId ||
    now >= current.supervisor.leaseExpiresAt
  )
    return { ok: false, code: "ownership-unavailable" };
  if (current.state === "terminal") return { ok: false, code: "sealed" };
  if (!Number.isSafeInteger(now) || now < current.createdAt)
    return { ok: false, code: "invalid-transition" };
  const next = { ...current, revision: current.revision + 1 };
  switch (change.kind) {
    case "started":
      return current.state === "queued" && now < current.deadline
        ? {
            ok: true,
            value: { ...next, state: "running", process: change.process, terminal: null },
          }
        : { ok: false, code: "invalid-transition" };
    case "attachment":
      return current.state !== "settling" && now < current.deadline
        ? { ok: true, value: { ...next, attachment: change.attachment } }
        : { ok: false, code: "invalid-transition" };
    case "settling":
      return current.state !== "settling"
        ? { ok: true, value: { ...next, state: "settling", terminal: null } }
        : { ok: false, code: "invalid-transition" };
    case "sealed":
      return current.state === "settling" &&
        change.terminal.sealedAt === now &&
        processTaskTerminalSchema.safeParse(change.terminal).success &&
        (change.terminal.outcome !== "completed" || current.process !== null)
        ? { ok: true, value: { ...next, state: "terminal", terminal: change.terminal } }
        : { ok: false, code: "invalid-transition" };
  }
}
