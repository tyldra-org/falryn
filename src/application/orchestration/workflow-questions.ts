/** Native question capabilities stay with the host; graph records retain only request/settlement references. */
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import type { ProcessTaskHandle } from "../../domain/orchestration/process-task.ts";
import type { QuestionInput } from "../../domain/orchestration/question.ts";
import type {
  WorkflowNodeRecord,
  WorkflowRecord,
} from "../../domain/orchestration/workflow-state.ts";
import type { ProductTaskResources } from "./product-resources.ts";
import type { StructuredQuestions } from "./structured-questions.ts";
import type { WorkflowHost, WorkflowNodeOutcome } from "./workflow-host.ts";

type QuestionCreated = Extract<
  Awaited<ReturnType<StructuredQuestions["create"]>>,
  { ok: true }
>["value"];
type Control = QuestionCreated["control"];
const identity = (record: WorkflowRecord, node: WorkflowNodeRecord): ProcessTaskHandle => ({
  version: 1,
  taskId: `question-${canonicalDigest([record.handle, node.key]).slice(7, 47)}`,
  generation: record.handle.generation,
});
export function createWorkflowQuestions(
  questions: StructuredQuestions,
  principal: QuestionInput["presenter"],
) {
  const controls = new Map<string, Control>();
  const listeners = new Set<(created: QuestionCreated) => void | Promise<void>>();
  const key = (handle: ProcessTaskHandle) => canonicalJson(handle);
  const subscriptions = new Map<string, () => void>();
  function remember(handle: ProcessTaskHandle, control: Control, resources: ProductTaskResources) {
    const id = key(handle);
    const unsubscribe = resources.onClose(() => {
      controls.delete(id);
      subscriptions.delete(id);
    });
    if (!unsubscribe) return false;
    subscriptions.get(id)?.();
    subscriptions.set(id, unsubscribe);
    controls.set(id, control);
    return true;
  }
  function inspect(instance: WorkflowNodeRecord, record: WorkflowRecord): WorkflowNodeOutcome {
    const expected = identity(record, instance);
    if (!instance.question || key(instance.question) !== key(expected))
      return { state: "failed", effect: "none", reason: "workflow-question-generation-mismatch" };
    const control = controls.get(key(expected));
    if (!control)
      return {
        state: "waiting",
        effect: "none",
        reason: "workflow-question-owner-rebind-required",
      };
    const current = control.inspect();
    if (!current.ok) throw new Error("workflow-question-owner-unavailable");
    const settled = current.value.settlement;
    if (!settled) return { state: "waiting", effect: "none", question: expected };
    return {
      state:
        settled.kind === "answered"
          ? "completed"
          : settled.kind === "cancelled"
            ? "cancelled"
            : settled.kind === "expired"
              ? "timed-out"
              : "failed",
      effect: "none",
      question: expected,
      reason: `workflow-question-${settled.kind}`,
      value: {
        handle: expected,
        settlementId: settled.id,
        state: settled.kind,
        digest: settled.digest,
        retained: settled.retained,
        effectAuthority: false,
      },
    };
  }
  const create: WorkflowHost["execute"] = async (
    node,
    input,
    record,
    instance,
    resources,
    signal,
  ) => {
    if (node.kind !== "question")
      return { state: "failed", effect: "none", reason: "workflow-question-kind" };
    const handle = identity(record, instance);
    if (controls.size >= 256 && !controls.has(key(handle)))
      return { state: "failed", effect: "none", reason: "workflow-question-limit" };
    if (controls.has(key(handle))) return inspect({ ...instance, question: handle }, record);
    const requested = { ...node.request, ...input };
    if (node.limits.wallTimeMs !== undefined && typeof requested.waitMs === "number")
      requested.waitMs = Math.min(requested.waitMs, node.limits.wallTimeMs);
    const created = await questions.create(
      {
        ...record.owner,
        invocationId: instance.invocation ?? record.owner.invocationId,
        resourceTaskId: resources.id,
        generation: resources.generation,
      },
      resources,
      { ...requested, version: 1, handle, presenter: principal },
      signal,
    );
    if (!created.ok)
      return { state: "failed", effect: "none", reason: `workflow-question-${created.error.code}` };
    if (!remember(handle, created.value.control, resources))
      return { state: "failed", effect: "none", reason: "workflow-question-owner-unavailable" };
    const published = await created.value.control.publish(signal);
    if (!published.ok)
      return {
        state: "uncertain",
        effect: "none",
        question: handle,
        reason: "workflow-question-publication-unavailable",
      };
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(created.value)).catch(() => {});
      } catch {
        /* A missing presenter never supplies a default answer. */
      }
    }
    return inspect({ ...instance, question: handle }, record);
  };
  return {
    create,
    inspect: async (instance: WorkflowNodeRecord, record: WorkflowRecord) =>
      inspect(instance, record),
    async wait(record: WorkflowRecord, signal: AbortSignal) {
      const waiting = record.nodes.filter((node) => node.state === "waiting" && node.question);
      const available = waiting.map((node) =>
        node.question ? controls.get(key(node.question)) : undefined,
      );
      if (available.length === 0 || available.some((control) => !control))
        throw new Error("workflow-question-owner-rebind-required");
      const stop = new AbortController();
      try {
        await Promise.race(
          available.map(async (control) => {
            if (!control) throw new Error("workflow-question-owner-rebind-required");
            const settled = await control.wait(AbortSignal.any([signal, stop.signal]));
            if (!settled.ok) throw new Error("workflow-question-owner-unavailable");
          }),
        );
      } finally {
        stop.abort();
      }
    },
    /** Rebinding requires the original host capability and exact immutable workflow node. */
    restore(
      record: WorkflowRecord,
      node: WorkflowNodeRecord,
      ownerToken: unknown,
      resources: ProductTaskResources,
    ) {
      const handle = identity(record, node);
      if (!node.question || key(node.question) !== key(handle)) return false;
      const resumed = questions.resume(handle, ownerToken, resources);
      if (!resumed.ok || (controls.size >= 256 && !controls.has(key(handle)))) return false;
      return remember(handle, resumed.value, resources);
    },
    subscribe(listener: (created: QuestionCreated) => void | Promise<void>) {
      if (listeners.size >= 8) throw new Error("workflow-question-presenter-limit");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type WorkflowQuestions = ReturnType<typeof createWorkflowQuestions>;
