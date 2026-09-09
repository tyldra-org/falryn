/** Owns one captured task from durable admission through sealed, notify-only settlement. */
import { createHash } from "node:crypto";
import type { ArtifactStorePort } from "../../domain/artifacts/artifact.ts";
import { type ClockPort, instant } from "../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import {
  MAX_PROCESS_TASK_RESPONSE_BYTES,
  MAX_PROCESS_TASK_WAITERS,
  PROCESS_TASK_LEASE_MS,
  PROCESS_TASK_LEASE_RENEWAL_MS,
  type ProcessTaskControl,
  type ProcessTaskExecution,
  type ProcessTaskFence,
  type ProcessTaskHandle,
  type ProcessTaskSnapshot,
  type ProcessTaskTerminal,
  processTaskReceipt,
} from "../../domain/orchestration/process-task.ts";
import type {
  ProcessTaskStore,
  ProcessTaskWake,
} from "../../domain/orchestration/process-task-store.ts";
import type {
  OwnedProcessCapture,
  ProcessCaptureOwnership,
  ProcessCaptureReport,
} from "../../domain/process/process-capture.ts";
import type { ProcessBirthIdentity } from "../../domain/process/process-identity.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { createProcessTaskBuffer } from "./process-task-buffer.ts";
import {
  projectProcessTaskBytes,
  readProcessTaskBytes,
  retainProcessTaskBytes,
} from "./process-task-output.ts";
import type { ProductTaskResources } from "./product-resources.ts";

type TaskError = { readonly code: string };
export type ProcessTaskNotification = {
  readonly wake: ProcessTaskWake;
  readonly task: ReturnType<typeof processTaskReceipt>;
  readonly action: "inspect-result";
};
export type ProcessTaskRun = {
  readonly onAdmitted?: (handle: ProcessTaskHandle) => void;
  readonly executionKind?: "process" | "agent";
  readonly request: ToolRunnerRequest;
  readonly execution: ProcessTaskExecution;
  readonly timeoutMs: number;
  readonly outputMode: "raw" | "hush";
  run(
    ownership: ProcessCaptureOwnership,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{
    readonly outcome: ToolInvocationOutcome;
    readonly capture: ProcessCaptureReport | null;
    readonly agentTerminal?: Pick<ProcessTaskTerminal, "outcome" | "effect">;
  }>;
};
export type ProcessTaskSupervisorOptions = {
  readonly store: ProcessTaskStore;
  readonly artifacts: ArtifactStorePort;
  readonly clock: ClockPort;
  readonly runId: string;
  readonly process: ProcessBirthIdentity | null;
  readonly notify?: (notice: ProcessTaskNotification, signal: AbortSignal) => Promise<boolean>;
};
type Active = {
  readonly handle: ProcessTaskHandle;
  readonly cancel: AbortController;
  readonly done: Promise<void>;
  readonly output: ReturnType<typeof createProcessTaskBuffer>;
  native: OwnedProcessCapture | null;
  failure: string | null;
  parentClosed: boolean;
  unsubscribeParent: (() => void) | null;
};

function refused(reason: string): ToolInvocationOutcome {
  return { status: "unavailable", reason, effect: "none" };
}
function fence(task: ProcessTaskSnapshot): ProcessTaskFence {
  return {
    handle: task.handle,
    supervisorRunId: task.supervisor.runId,
    expectedRevision: task.revision,
  };
}
function boundedOutput(output: Readonly<Record<string, unknown>>): ToolInvocationOutcome {
  return Buffer.byteLength(JSON.stringify(output)) <= MAX_PROCESS_TASK_RESPONSE_BYTES
    ? { status: "completed", output, effect: "completed" }
    : refused("process-task-control-limit");
}
function terminalFacts(
  capture: ProcessCaptureReport | null,
  outcome: ToolInvocationOutcome,
  failure: string | null,
  executionKind: "process" | "agent" = "process",
): Omit<ProcessTaskTerminal, "sealedAt" | "result"> {
  const evidence = {
    exitCode: capture?.exit.exitCode ?? null,
    signal: capture?.exit.signal ?? null,
    outputComplete:
      capture !== null &&
      capture.stdout.omittedBytes === 0 &&
      capture.stderr.omittedBytes === 0 &&
      capture.killStage !== "unconfirmed" &&
      capture.stop.kind !== "uncertain" &&
      failure === null,
  };
  if (failure !== null)
    return {
      ...evidence,
      outcome: "uncertain",
      effect: "uncertain",
      reason: "persistence-unavailable",
    };
  if (executionKind === "agent") {
    const observed = { exitCode: null, signal: null, outputComplete: true };
    if (outcome.status === "completed")
      return {
        ...observed,
        outcome: "completed",
        effect: outcome.effect,
        reason: "agent-completed",
      };
    if (outcome.status === "uncertain")
      return {
        ...observed,
        outcome: "uncertain",
        effect: "uncertain",
        reason: "ownership-uncertain",
      };
    if (outcome.status === "cancelled" || outcome.status === "timed-out")
      return {
        ...observed,
        outcome: outcome.status,
        effect: outcome.effect,
        reason: outcome.status,
      };
    return { ...observed, outcome: "failed", effect: outcome.effect, reason: "agent-failed" };
  }
  if (capture === null)
    return outcome.status === "cancelled"
      ? { ...evidence, outcome: "cancelled", effect: "none", reason: "cancelled" }
      : { ...evidence, outcome: "failed", effect: "none", reason: "spawn-failed" };
  if (capture.killStage === "unconfirmed")
    return { ...evidence, outcome: "uncertain", effect: "uncertain", reason: "unconfirmed-exit" };
  const effect = capture.pid === null ? "none" : "partial";
  switch (capture.stop.kind) {
    case "exited":
      return capture.exit.exitCode === 0 && capture.exit.signal === null
        ? { ...evidence, outcome: "completed", effect: "completed", reason: "exited" }
        : { ...evidence, outcome: "failed", effect, reason: "exited" };
    case "cancelled":
      return { ...evidence, outcome: "cancelled", effect, reason: "cancelled" };
    case "timed-out":
      return { ...evidence, outcome: "timed-out", effect, reason: "timed-out" };
    case "capture-exceeded":
      return { ...evidence, outcome: "failed", effect, reason: "capture-exceeded" };
    case "uncertain":
      return {
        ...evidence,
        outcome: "uncertain",
        effect: "uncertain",
        reason:
          capture.stop.reason === "unconfirmed-exit" ? "unconfirmed-exit" : "ownership-uncertain",
      };
  }
}

export function createProcessTaskSupervisor(options: ProcessTaskSupervisorOptions) {
  const { store, artifacts, clock } = options;
  const active = new Map<string, Active>();
  const waits = new Set<{ handle: ProcessTaskHandle; notify(): void }>();
  const failures = new Set<string>();
  let accepting = true;
  const interruptionListeners = new Set<() => void>();
  const now = () => Number(clock.now());
  const owned = (handle: ProcessTaskHandle) => {
    const current = active.get(handle.taskId);
    return current?.handle.generation === handle.generation ? current : undefined;
  };
  const changed = (handle: ProcessTaskHandle) => {
    for (const wait of waits)
      if (wait.handle.taskId === handle.taskId && wait.handle.generation === handle.generation)
        wait.notify();
  };

  async function deliver(task: ProcessTaskSnapshot): Promise<void> {
    if (task.state !== "terminal") return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const claim = store.claimWake(task.handle);
      if (!claim.ok) return;
      let delivered = false;
      if (options.notify !== undefined) {
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), 1_000);
        try {
          const expired = new Promise<false>((resolve) =>
            stop.signal.addEventListener("abort", () => resolve(false), { once: true }),
          );
          delivered = await Promise.race([
            options
              .notify(
                {
                  wake: claim.value.value,
                  task: processTaskReceipt(task),
                  action: "inspect-result",
                },
                stop.signal,
              )
              .catch(() => false),
            expired,
          ]);
        } finally {
          clearTimeout(timer);
          stop.abort();
        }
      }
      if (delivered) {
        const acknowledged = store.acknowledgeWake(task.handle, claim.value.value.notificationId);
        if (acknowledged.ok) return;
      }
    }
    // This records exhaustion without incrementing the durable attempt count.
    store.claimWake(task.handle);
  }

  async function renew(entry: Active, stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      await clock.waitUntil(instant(now() + PROCESS_TASK_LEASE_RENEWAL_MS), stop);
      if (stop.aborted) return;
      const current = store.get(entry.handle);
      if (current.ok && current.value.state === "terminal") return;
      if (!current.ok || !store.renew(fence(current.value), now()).ok) {
        entry.failure = "lease-renewal-failed";
        entry.cancel.abort();
        return;
      }
    }
  }

  function prepareParent(entry: Active, parent: ProductTaskResources) {
    let closed = false;
    let committed = false;
    const unsubscribe = parent.onClose(() => {
      closed = true;
      if (!committed) return;
      entry.parentClosed = true;
      const current = store.get(entry.handle);
      if (!current.ok || current.value.attachment === "foreground") entry.cancel.abort();
    });
    if (unsubscribe === null) return null;
    if (closed) {
      unsubscribe();
      return null;
    }
    return {
      rollback: unsubscribe,
      commit() {
        entry.unsubscribeParent?.();
        entry.unsubscribeParent = unsubscribe;
        entry.parentClosed = closed;
        committed = true;
        if (closed) entry.cancel.abort();
      },
    };
  }

  async function settle(
    entry: Active,
    result: Awaited<ReturnType<ProcessTaskRun["run"]>>,
  ): Promise<ToolInvocationOutcome> {
    let current = store.get(entry.handle);
    if (!current.ok)
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "task-settlement-unavailable",
      };
    const settling = store.transition(fence(current.value), { kind: "settling" }, now());
    if (!settling.ok)
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "task-settlement-unavailable",
      };
    const bytes = new TextEncoder().encode(JSON.stringify(result.outcome));
    const saved =
      bytes.byteLength <= MAX_PROCESS_TASK_RESPONSE_BYTES
        ? await retainProcessTaskBytes(
            artifacts,
            settling.value.value,
            "result",
            bytes,
            "application/json",
          )
        : err({ code: "result-limit" });
    if (!saved.ok) entry.failure = "result-persistence-failed";
    current = store.get(entry.handle);
    if (!current.ok)
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "task-settlement-unavailable",
      };
    const observed = terminalFacts(
      result.capture,
      result.outcome,
      entry.failure,
      current.value.executionKind === "agent" ? "agent" : "process",
    );
    const facts =
      current.value.executionKind === "agent" && result.agentTerminal && entry.failure === null
        ? {
            ...observed,
            ...result.agentTerminal,
            reason:
              result.agentTerminal.outcome === "completed"
                ? ("agent-completed" as const)
                : result.agentTerminal.outcome === "cancelled" ||
                    result.agentTerminal.outcome === "timed-out"
                  ? result.agentTerminal.outcome
                  : ("agent-failed" as const),
          }
        : observed;
    const sealedAt = now();
    const sealed = store.transition(
      fence(current.value),
      {
        kind: "sealed",
        terminal: {
          ...facts,
          sealedAt,
          result: saved.ok ? saved.value : null,
        },
      },
      sealedAt,
    );
    if (!sealed.ok)
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "task-settlement-unavailable",
      };
    changed(entry.handle);
    await deliver(sealed.value.value);
    return entry.failure === null
      ? result.outcome
      : { status: "uncertain", effect: "uncertain", recoveryHint: "task-output-unavailable" };
  }

  async function run(input: ProcessTaskRun): Promise<ToolInvocationOutcome> {
    const authority = input.request.processTask;
    const parent = input.request.taskResources;
    if (!accepting || authority === undefined || parent === undefined || options.process === null)
      return refused("process-task-owner-unavailable");
    const createdAt = now();
    const digest = createHash("sha256")
      .update(
        JSON.stringify([input.request.capabilityId, input.request.version, input.request.input]),
      )
      .digest("hex");
    const taskId = `task-${createHash("sha256").update(`${authority.owner.sessionId}:${authority.owner.invocationId}`).digest("hex")}`;
    const handle: ProcessTaskHandle = {
      version: 1,
      taskId,
      generation: createHash("sha256")
        .update(`${options.runId}:${authority.owner.attemptId}:${taskId}`)
        .digest("hex"),
    };
    const task: ProcessTaskSnapshot = {
      ...(input.executionKind === undefined ? {} : { executionKind: input.executionKind }),
      handle,
      revision: 1,
      owner: authority.owner,
      supervisor: {
        runId: options.runId,
        process: options.process,
        leaseExpiresAt: createdAt + PROCESS_TASK_LEASE_MS,
      },
      attachment: input.execution.attachment,
      createdAt,
      deadline: Math.min(
        createdAt + input.timeoutMs,
        authority.deadline ?? parent.expiresAt,
        parent.expiresAt,
      ),
      inputDigest: digest,
      outputMode: input.outputMode,
      state: "queued",
      process: null,
      terminal: null,
    };
    const created = store.create(task, input.request.signal);
    if (!created.ok) return refused(`process-task-${created.error.code}`);
    input.onAdmitted?.(handle);
    const done = Promise.withResolvers<void>();
    const finished = Promise.all([done.promise, authority.finished]).then(() => {
      active.delete(taskId);
      changed(handle);
    });
    const entry: Active = {
      handle,
      cancel: new AbortController(),
      done: finished,
      output: createProcessTaskBuffer(async (stream, offset, bytes) => {
        const current = store.get(handle);
        if (!current.ok) throw new Error("task ownership unavailable");
        const saved = await retainProcessTaskBytes(
          artifacts,
          current.value,
          `${stream}:${offset}`,
          bytes,
        );
        const latest = store.get(handle);
        if (!saved.ok || !latest.ok) throw new Error("task output commit failed");
        const committed = store.appendChunk(
          fence(latest.value),
          { handle, stream, offset, artifact: saved.value },
          now(),
        );
        if (!committed.ok || committed.value.cancelledAfterCommit)
          throw new Error("task output commit failed");
      }),
      native: null,
      failure: null,
      parentClosed: false,
      unsubscribeParent: null,
    };
    active.set(taskId, entry);
    const renewalStop = new AbortController();
    const renewal = renew(entry, renewalStop.signal);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      const current = store.get(handle);
      if (
        !current.ok ||
        !authority.publishReceipt(boundedOutput(processTaskReceipt(current.value)))
      )
        entry.cancel.abort();
    };
    try {
      const attachment = prepareParent(entry, parent);
      if (attachment === null || created.value.cancelledAfterCommit) entry.cancel.abort();
      attachment?.commit();
      if (input.execution.attachment === "background") publish();
      else timer = setTimeout(publish, input.execution.foregroundWaitMs);
      const signal = AbortSignal.any([input.request.signal, entry.cancel.signal]);
      if (input.executionKind === "agent") {
        const current = store.get(handle);
        if (
          !current.ok ||
          !store.transition(fence(current.value), { kind: "started", process: null }, now()).ok
        )
          throw new Error("agent start commit failed");
      }
      const result = await input.run(
        {
          async started(native) {
            const current = store.get(handle);
            if (!current.ok) throw new Error("task ownership unavailable");
            const committed = store.transition(
              fence(current.value),
              { kind: "started", process: native.identity },
              now(),
            );
            if (!committed.ok || committed.value.cancelledAfterCommit)
              throw new Error("task start commit failed");
            entry.native = native;
          },
          async event(event) {
            if (event.kind !== "chunk") return;
            try {
              if (entry.failure !== null) throw new Error("task output unavailable");
              await entry.output.append(event.stream, event.bytes);
            } catch (error) {
              entry.failure = "output-persistence-failed";
              throw error;
            }
          },
        },
        signal,
        Math.max(1, task.deadline - now()),
      );
      authority.reportTermination?.(
        result.capture === null
          ? entry.native === null
          : result.capture.killStage !== "unconfirmed" &&
              !(
                result.capture.stop.kind === "uncertain" &&
                result.capture.stop.reason === "unconfirmed-exit"
              ),
      );
      if (result.capture === null && entry.native !== null)
        entry.failure = "capture-evidence-unavailable";
      try {
        if (entry.failure === null) await entry.output.finish();
      } catch {
        entry.failure = "output-persistence-failed";
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const outcome = await settle(entry, result);
      if (outcome.status === "uncertain") failures.add(handle.taskId);
      return outcome;
    } catch {
      entry.failure = "task-execution-failed";
      entry.cancel.abort();
      failures.add(handle.taskId);
      return {
        status: "uncertain",
        effect: "uncertain",
        recoveryHint: "task-execution-unavailable",
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      renewalStop.abort();
      await renewal;
      entry.unsubscribeParent?.();
      done.resolve();
    }
  }

  async function wait(
    handle: ProcessTaskHandle,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<Result<ProcessTaskSnapshot, TaskError>> {
    const current = store.get(handle);
    if (!current.ok || current.value.state === "terminal") return current;
    if (owned(handle) === undefined) return err({ code: "supervisor-unavailable" });
    if (waits.size >= MAX_PROCESS_TASK_WAITERS) return err({ code: "wait-capacity" });
    if (signal.aborted) return err({ code: "cancelled" });
    return new Promise((resolve) => {
      const finish = () => {
        if (!waits.delete(subscription)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve(signal.aborted ? err({ code: "cancelled" }) : store.get(handle));
      };
      const subscription = { handle, notify: finish };
      const timer = setTimeout(finish, waitMs);
      waits.add(subscription);
      signal.addEventListener("abort", finish, { once: true });
      const latest = store.get(handle);
      if (
        !latest.ok ||
        latest.value.state === "terminal" ||
        owned(handle) === undefined ||
        signal.aborted
      )
        finish();
    });
  }

  async function control(
    request: ToolRunnerRequest,
    input: ProcessTaskControl,
  ): Promise<ToolInvocationOutcome> {
    const scope = request.processTask?.owner;
    const retained = store.get(input);
    const cleaned =
      !retained.ok && retained.error.code === "not-found" && input.operation === "cleanup";
    const current = cleaned ? store.cleaned(input) : retained;
    if (!current.ok) return refused(`process-task-${current.error.code}`);
    if (current.value.executionKind === "question") return refused("question-owner-required");
    if (
      scope === undefined ||
      current.value.owner.sessionId !== scope.sessionId ||
      current.value.owner.workspaceId !== scope.workspaceId
    )
      return refused("process-task-foreign-owner");
    if (request.signal.aborted) return { status: "cancelled", effect: "none" };
    const task = current.value;
    if ("expectedRevision" in input && input.expectedRevision !== task.revision - (cleaned ? 1 : 0))
      return refused("process-task-stale-revision");
    if (cleaned) return boundedOutput({ kind: "process-task-cleaned", handle: task.handle });
    if (input.operation === "logs" || input.operation === "result") {
      const read = await readProcessTaskBytes(
        store,
        artifacts,
        task,
        input.operation === "logs" ? input.stream : "result",
        input.offset,
        input.limit,
        request.signal,
        input.operation === "logs" ? owned(task.handle)?.output.snapshot(input.stream) : undefined,
      );
      return read.ok
        ? boundedOutput({
            kind: "process-task-read",
            task: processTaskReceipt(task),
            source: input.operation === "logs" ? input.stream : "result",
            ...projectProcessTaskBytes(read.value),
          })
        : refused(`process-task-${read.error.code}`);
    }
    if (input.operation === "wait") {
      const read = await wait(input, input.waitMs, request.signal);
      return read.ok
        ? boundedOutput(processTaskReceipt(read.value))
        : refused(`process-task-${read.error.code}`);
    }
    if (input.operation === "inspect") {
      const receipt = processTaskReceipt(task);
      if (task.state !== "terminal") return boundedOutput(receipt);
      const wake = store.wake(task.handle);
      if (!wake.ok) return refused(`process-task-${wake.error.code}`);
      return boundedOutput({
        ...receipt,
        notification: {
          state: wake.value.state,
          attempts: wake.value.attempts,
          notificationId: wake.value.notificationId,
        },
      });
    }
    if (input.operation === "cleanup") {
      const cleaned = store.cleanup(input, input.expectedRevision, now(), request.signal);
      return cleaned.ok
        ? boundedOutput({ kind: "process-task-cleaned", handle: task.handle })
        : refused(`process-task-${cleaned.error.code}`);
    }
    const entry = owned(input);
    if (entry === undefined || task.state === "terminal" || task.supervisor.leaseExpiresAt <= now())
      return refused("process-task-live-owner-unavailable");
    if (input.operation === "detach" || input.operation === "reattach") {
      let attachment: ReturnType<typeof prepareParent> = null;
      if (input.operation === "reattach") {
        if (request.taskResources === undefined) return refused("process-task-parent-unavailable");
        attachment = prepareParent(entry, request.taskResources);
        if (attachment === null) return refused("process-task-parent-unavailable");
      }
      if (input.operation === "detach" && entry.parentClosed)
        return refused("process-task-parent-closed");
      const changedTask = store.transition(
        fence(task),
        {
          kind: "attachment",
          attachment: input.operation === "detach" ? "background" : "foreground",
        },
        now(),
        request.signal,
      );
      if (changedTask.ok) attachment?.commit();
      else attachment?.rollback();
      return changedTask.ok
        ? boundedOutput(processTaskReceipt(changedTask.value.value))
        : refused(`process-task-${changedTask.error.code}`);
    }
    if (entry.native === null) entry.cancel.abort();
    else {
      const stopped = await entry.native.stop(input.operation === "kill", () => {
        const latest = store.get(input);
        return (
          !request.signal.aborted &&
          latest.ok &&
          latest.value.revision === input.expectedRevision &&
          latest.value.state !== "terminal" &&
          latest.value.supervisor.leaseExpiresAt > now()
        );
      });
      if (stopped !== "requested") return refused("process-task-live-owner-unavailable");
    }
    return boundedOutput({
      kind: "process-task-stop-requested",
      operation: input.operation,
      task: processTaskReceipt(task),
    });
  }

  return {
    run,
    control,
    deliver,
    onInterrupt(listener: () => void) {
      interruptionListeners.add(listener);
      return () => {
        interruptionListeners.delete(listener);
      };
    },
    interrupt() {
      for (const entry of active.values()) entry.cancel.abort();
      for (const listener of interruptionListeners) listener();
    },
    async drain(): Promise<Result<void, TaskError>> {
      accepting = false;
      await Promise.all([...active.values()].map((entry) => entry.done));
      return failures.size === 0
        ? ok(undefined)
        : err({ code: "process-task-settlement-unavailable" });
    },
    report: () => ({ active: active.size, waits: waits.size, failures: failures.size }),
  };
}
export type ProcessTaskSupervisor = ReturnType<typeof createProcessTaskSupervisor>;
