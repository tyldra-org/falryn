/** One direct action owner for programmatic and tool workflow consumers. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import { ok } from "../../domain/foundation/result.ts";
import {
  decodeWorkflowDefinition,
  validWorkflowArguments,
  type WorkflowDefinition,
} from "../../domain/orchestration/workflow-definition.ts";
import {
  type WorkflowHandle,
  type WorkflowRecord,
  type WorkflowStore,
  workflowHandleSchema,
} from "../../domain/orchestration/workflow-state.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { roleRouteBaseSchema } from "../../providers/configuration/policy-schema.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { ProcessTaskSupervisor } from "./process-task-supervisor.ts";
import type { WorkflowExecution } from "./workflow-execution.ts";
import type { WorkflowHost } from "./workflow-host.ts";

export const workflowCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.enum(["validate", "preview"]),
    definition: z.json(),
    arguments: z.json().optional(),
  }),
  z.strictObject({
    operation: z.literal("execute"),
    handle: workflowHandleSchema,
    definition: z.json(),
    arguments: z.json(),
    reuse: workflowHandleSchema.optional(),
    model: roleRouteBaseSchema.optional(),
    steps: z
      .record(z.string().min(1).max(128), roleRouteBaseSchema)
      .refine((value) => Object.keys(value).length <= 256)
      .optional(),
  }),
  z.strictObject({
    operation: z.enum(["inspect", "result", "resume"]),
    handle: workflowHandleSchema,
    offset: z.int().nonnegative().default(0),
  }),
  z.strictObject({
    operation: z.enum(["pause", "cancel"]),
    handle: workflowHandleSchema,
    expectedRevision: z.int().positive(),
  }),
  z.strictObject({ operation: z.literal("list"), after: workflowHandleSchema.optional() }),
]);
export type WorkflowCommand = z.infer<typeof workflowCommandSchema>;
const refused = (reason: string): ToolInvocationOutcome => ({
  status: "unavailable",
  reason,
  effect: "none",
});
const completed = (output: Readonly<Record<string, unknown>>): ToolInvocationOutcome => ({
  status: "completed",
  output,
  effect: "completed",
});
function workflowEffect(record: WorkflowRecord) {
  return record.nodes.some((node) => node.effect === "uncertain")
    ? ("uncertain" as const)
    : record.nodes.some((node) => node.effect === "partial")
      ? ("partial" as const)
      : record.nodes.some((node) => node.effect === "completed")
        ? ("completed" as const)
        : ("none" as const);
}
export function workflowSummary(record: WorkflowRecord, offset = 0) {
  const summary = {
    kind: "workflow-run",
    handle: record.handle,
    revision: record.revision,
    state: record.state,
    definitionId: record.definition.id,
    definitionDigest: record.definitionDigest,
    task: record.task,
    createdAt: record.createdAt,
    deadline: record.deadline,
    output: record.output,
    spent: record.spent,
    nodes: [] as Omit<WorkflowRecord["nodes"][number], "item">[],
    nextOffset: null as number | null,
    totalNodes: record.nodes.length,
  };
  for (const { item: _item, ...node } of record.nodes.slice(offset, offset + 50)) {
    if (Buffer.byteLength(canonicalJson({ ...summary, nodes: [...summary.nodes, node] })) > 48_000)
      break;
    summary.nodes.push(node);
  }
  summary.nextOffset =
    offset + summary.nodes.length < record.nodes.length ? offset + summary.nodes.length : null;
  return summary;
}
export type WorkflowActionsOptions = {
  readonly execution: WorkflowExecution;
  readonly store: WorkflowStore;
  readonly tasks: ProcessTaskSupervisor;
  readonly now: () => number;
  /** Captures validated native bindings; a recovery supplies the immutable original record. */
  prepare(
    definition: WorkflowDefinition,
    request: ToolRunnerRequest,
    record?: WorkflowRecord,
    routes?: Pick<Extract<WorkflowCommand, { operation: "execute" }>, "model" | "steps">,
  ): Promise<WorkflowHost | null>;
};

export function createWorkflowActions(options: WorkflowActionsOptions) {
  const active = new Map<string, { stop: AbortController; wake: () => void }>();
  const key = (handle: WorkflowHandle) => canonicalJson(handle);
  async function launch(
    record: WorkflowRecord,
    host: WorkflowHost,
    request: ToolRunnerRequest,
  ): Promise<ToolInvocationOutcome> {
    if (!request.processTask || !request.taskResources) {
      host.resources.close();
      return refused("workflow-task-owner-required");
    }
    const identity = key(record.handle);
    if (active.has(identity)) {
      host.resources.close();
      active.get(identity)?.wake();
      return completed(workflowSummary(record));
    }
    if (["completed", "failed", "cancelled", "timed-out", "uncertain"].includes(record.state)) {
      host.resources.close();
      return completed(workflowSummary(record));
    }
    if (record.task !== null && !(await host.fenced(record.task))) {
      host.resources.close();
      return refused("workflow-owner-unsettled");
    }
    if (record.executor !== null) {
      const released = options.store.change(record.handle, record.revision, (current) =>
        ok({
          ...current,
          executor: null,
          revision: current.revision + 1,
          updatedAt: options.now(),
        }),
      );
      if (!released.ok) {
        host.resources.close();
        return refused(`workflow-${released.error.code}`);
      }
      record = released.value;
    }
    const release = host.resources.retain();
    if (!release) {
      host.resources.close();
      return refused("workflow-resource-owner-unavailable");
    }
    const first = Promise.withResolvers<ToolInvocationOutcome>();
    const stop = new AbortController();
    let wake = Promise.withResolvers<void>();
    active.set(identity, { stop, wake: () => wake.resolve() });
    const originalAuthority = request.processTask;
    const taskRequest: ToolRunnerRequest = {
      ...request,
      taskResources: host.resources,
      signal: AbortSignal.any([request.signal, stop.signal]),
      processTask: {
        ...originalAuthority,
        owner: { ...originalAuthority.owner, resourceTaskId: host.resources.id },
        finished: Promise.resolve(),
        publishReceipt(task) {
          const current = options.store.get(record.handle);
          if (!current.ok) return false;
          first.resolve(
            completed({
              ...workflowSummary(current.value),
              taskReceipt: task.status === "completed" ? task.output : null,
            }),
          );
          return true;
        },
      },
    };
    const running = options.tasks.run({
      request: taskRequest,
      executionKind: "workflow",
      outputMode: "raw",
      timeoutMs: Math.max(1, record.deadline - options.now()),
      execution: {
        version: 1,
        attachment: "foreground",
        foregroundWaitMs: 30000,
        onSettle: "notify",
        shutdown: "drain",
      },
      onAdmitted(task) {
        const current = options.store.get(record.handle);
        if (
          !current.ok ||
          !options.store.change(record.handle, current.value.revision, (value) =>
            ok({ ...value, task, revision: value.revision + 1, updatedAt: options.now() }),
          ).ok
        )
          throw new Error("workflow-task-link-unavailable");
      },
      async run(_ownership, signal) {
        for (;;) {
          const driven = await options.execution.drive(record.handle, host, signal);
          if (!driven.ok)
            return {
              outcome: refused(`workflow-${driven.error.code}`),
              capture: null,
              executionTerminal: { outcome: "uncertain" as const, effect: "uncertain" as const },
            };
          const current = driven.value;
          if (!["waiting", "paused"].includes(current.state) || signal.aborted) {
            const effect = workflowEffect(current);
            const outcome =
              current.state === "completed"
                ? ("completed" as const)
                : current.state === "uncertain"
                  ? ("uncertain" as const)
                  : current.state === "cancelled" || current.state === "timed-out"
                    ? current.state
                    : ("failed" as const);
            return {
              outcome: completed(workflowSummary(current)),
              capture: null,
              executionTerminal: { outcome, effect },
            };
          }
          first.resolve(completed(workflowSummary(current)));
          const interrupt = () => wake.resolve();
          signal.addEventListener("abort", interrupt, { once: true });
          const waiter = new AbortController();
          try {
            await Promise.race([
              wake.promise,
              ...(current.state === "waiting" && host.wait
                ? [host.wait(current, AbortSignal.any([signal, waiter.signal]))]
                : []),
            ]);
          } catch {
            if (!signal.aborted)
              return {
                outcome: refused("workflow-wait-owner-unavailable"),
                capture: null,
                executionTerminal: { outcome: "failed" as const, effect: workflowEffect(current) },
              };
          } finally {
            waiter.abort();
            signal.removeEventListener("abort", interrupt);
          }
          wake = Promise.withResolvers<void>();
        }
      },
    });
    void running
      .then(first.resolve, () => first.resolve(refused("workflow-settlement-unavailable")))
      .finally(() => {
        active.delete(identity);
        host.resources.close();
        release();
      });
    return first.promise;
  }

  return {
    async execute(raw: unknown, request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      const parsed = workflowCommandSchema.safeParse(raw);
      if (!parsed.success) return refused("workflow-command-invalid");
      const command = parsed.data;
      if (command.operation === "list") {
        const owner = request.processTask?.owner;
        if (!owner) return refused("workflow-owner-required");
        const page = options.store.page(owner.workspaceId, owner.sessionId, command.after);
        return page.ok
          ? completed({ kind: "workflow-runs", entries: page.value })
          : refused(`workflow-${page.error.code}`);
      }
      if ("definition" in command) {
        const decoded = decodeWorkflowDefinition(command.definition);
        if (!decoded.ok)
          return completed({ kind: "workflow-invalid", diagnostics: decoded.diagnostics });
        const host = await options.prepare(
          decoded.definition,
          request,
          undefined,
          command.operation === "execute" ? command : undefined,
        );
        if (!host) return refused("workflow-native-owner-unavailable");
        const diagnostics = [
          ...host.validate(decoded.definition),
          ...(command.arguments !== undefined &&
          !validWorkflowArguments(decoded.definition, command.arguments)
            ? [{ path: "arguments", code: "workflow-arguments-invalid" }]
            : []),
        ];
        if (command.operation !== "execute") {
          host.resources.close();
          return completed({
            kind: "workflow-preview",
            valid: diagnostics.length === 0,
            diagnostics,
            definitionId: decoded.definition.id,
            digest: decoded.digest,
            effects: [
              ...new Set(
                decoded.definition.nodes.flatMap((node) =>
                  node.kind === "action"
                    ? [node.effect]
                    : node.kind === "agent"
                      ? node.effects
                      : [],
                ),
              ),
            ],
            dynamic: decoded.definition.nodes.some((node) => node.forEach !== undefined),
            cost: "unmeasured",
            nodes: decoded.definition.nodes.length,
            routes: host.routes(decoded.definition),
            executionStarted: false,
          });
        }
        const admitted = await options.execution.admit(
          {
            handle: command.handle,
            definition: command.definition,
            arguments: command.arguments,
            ...(command.reuse ? { reuse: command.reuse } : {}),
          },
          host,
          request.signal,
        );
        if (!admitted.ok) {
          host.resources.close();
          return refused(`workflow-${admitted.error.code}`);
        }
        return launch(admitted.value, host, request);
      }
      const read = options.store.get(command.handle);
      if (!read.ok) return refused(`workflow-${read.error.code}`);
      const owner = request.processTask?.owner;
      if (
        !owner ||
        owner.workspaceId !== read.value.owner.workspaceId ||
        owner.sessionId !== read.value.owner.sessionId
      )
        return refused("workflow-foreign-owner");
      if (command.operation === "inspect" || command.operation === "result")
        return completed(workflowSummary(read.value, command.offset));
      const host = await options.prepare(read.value.definition, request, read.value);
      if (!host) return refused("workflow-native-owner-unavailable");
      if (command.operation === "resume") {
        if (active.has(key(command.handle))) {
          host.resources.close();
          active.get(key(command.handle))?.wake();
          return completed(workflowSummary(read.value));
        }
        return launch(read.value, host, request);
      }
      try {
        if (command.operation === "pause" || command.operation === "cancel") {
          const controlled = options.execution.control(
            command.handle,
            command.expectedRevision,
            command.operation,
            host,
          );
          if (!controlled.ok) return refused(`workflow-${controlled.error.code}`);
          if (command.operation === "cancel") {
            active.get(key(command.handle))?.stop.abort();
            active.get(key(command.handle))?.wake();
          }
          return completed(workflowSummary(controlled.value));
        }
        return refused("workflow-command-invalid");
      } finally {
        host.resources.close();
      }
    },
    newHandle: (): WorkflowHandle => ({
      id: randomUUID(),
      generation: canonicalDigest(randomUUID()).slice(7),
    }),
  };
}
export type WorkflowActions = ReturnType<typeof createWorkflowActions>;
