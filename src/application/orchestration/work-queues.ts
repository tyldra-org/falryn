import { createHash, randomUUID } from "node:crypto";
import { deadlineAt, instant } from "../../domain/foundation/index.ts";
import { err } from "../../domain/foundation/result.ts";
import { canonicalResourceValue } from "../../domain/orchestration/resource-admission.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  refuseWork,
  WORK_QUEUE_LIMITS,
  type WorkItem,
  type WorkQueue,
  type WorkQueueAuthority,
  type WorkQueueStore,
  type WorkQueueTransaction,
  type WorkReceipt,
  type WorkResult,
} from "../../domain/orchestration/work-queue.ts";
import {
  applyWorkMutation,
  validateWorkItem,
} from "../../domain/orchestration/work-queue-mutations.ts";
import {
  type WorkQueueRequest,
  workQueueRequestSchema,
} from "../../domain/orchestration/work-queue-requests.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";
import type { ProductTaskResources } from "./product-resources.ts";

export const workDigest = (value: unknown) =>
  createHash("sha256").update(canonicalResourceValue(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export type WorkQueueResponse = {
  readonly queue: WorkQueue | null;
  readonly durability: "ephemeral" | "durable";
  readonly receipt?: WorkReceipt;
  readonly items?: readonly WorkItem[];
  readonly edges?: readonly string[];
  readonly history?: readonly WorkReceipt[];
  readonly next?: string | number | null;
};

function hasSecret(value: unknown): boolean {
  if (typeof value === "string") return containsRedactableSecret(value);
  if (Array.isArray(value)) return value.some(hasSecret);
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([key, child]) =>
        (key === "metadata" &&
          child !== null &&
          typeof child === "object" &&
          Object.keys(child).some((name) => containsRedactableSecret(`${name}=value`))) ||
        hasSecret(child),
    );
  return false;
}

/** The host supplies an already registered location and current authority for every call. */
export function createWorkQueueActions(
  store: WorkQueueStore,
  options: {
    readonly resources: ProductTaskResources;
    readonly authority: WorkQueueAuthority;
    readonly now?: () => number;
    readonly validationMs?: number;
    readonly traversalSteps?: number;
  },
) {
  const now = options.now ?? Date.now;
  const authority = options.authority;
  function authorize(queue: WorkQueue, operation: "read" | "create" | "mutate") {
    const scope = queue.scope;
    if (
      scope.locator !== store.locator ||
      scope.workspaceId !== authority.workspaceId ||
      (["memory", "session", "session-global"].includes(scope.kind) &&
        scope.sessionId !== authority.sessionId) ||
      (scope.kind === "shared" &&
        scope.owner !== authority.actor &&
        !scope.members.includes(authority.actor)) ||
      !authority.authorize(queue, operation)
    )
      refuseWork("denied");
    if (
      (scope.kind === "memory" ||
        (operation === "create" &&
          !authority.persistentSession &&
          ["session", "session-global"].includes(scope.kind))) &&
      store.durability !== "ephemeral"
    )
      refuseWork("denied");
    if (
      (["project", "shared"].includes(scope.kind) ||
        (scope.kind === "session-global" &&
          operation === "create" &&
          authority.persistentSession)) &&
      store.durability !== "durable"
    )
      refuseWork("unavailable");
  }
  function perform(
    tx: WorkQueueTransaction,
    request: WorkQueueRequest,
    signal: AbortSignal,
    deadline: number,
  ): WorkQueueResponse {
    let steps = 0;
    const budget = {
      check() {
        if (signal.aborted) refuseWork("cancelled-operation");
        if (now() >= deadline)
          refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
      },
      step() {
        this.check();
        if (
          ++steps >
          Math.min(
            WORK_QUEUE_LIMITS.traversalSteps,
            options.traversalSteps ?? WORK_QUEUE_LIMITS.traversalSteps,
          )
        )
          refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
      },
    };
    budget.check();
    if (request.action === "resume") {
      const id = tx.binding(authority.sessionId, authority.workspaceId);
      const queue = id === null ? null : tx.queue(id);
      if (id !== null && queue === null) refuseWork("recovery-required");
      if (queue !== null) authorize(queue, "read");
      return { queue, durability: store.durability };
    }
    let queue = tx.queue(request.queueId);
    const isWrite = request.action === "create" || request.action === "mutate";
    if (request.action === "create") {
      const candidate: WorkQueue = {
        version: 1,
        id: request.queueId,
        scope: request.scope,
        revision: 0,
        objective: request.objective,
        createdAt: now(),
        updatedAt: now(),
      };
      authorize(candidate, queue === null ? "create" : "mutate");
      if (
        request.scope.owner !== authority.actor ||
        bytes(request.objective) > WORK_QUEUE_LIMITS.inlineBytes
      )
        refuseWork("denied");
      if (queue === null) queue = candidate;
    }
    if (queue === null) refuseWork("unavailable");
    authorize(queue, isWrite ? "mutate" : "read");
    if (request.action !== "create" && request.scopeGeneration !== queue.scope.generation)
      refuseWork("denied");
    if (isWrite) {
      if (!authority.sourceAvailable(request.source, request.sourceGeneration))
        refuseWork("stale-evidence");
      const intent = workDigest({ request, actor: authority.actor });
      const prior = tx.receipt(queue.id, request.mutationId);
      if (prior !== null) {
        if (prior.intent !== intent) refuseWork("conflicting-identity");
        const original = tx.queueAt(queue.id, prior.revision);
        if (original === null) refuseWork("recovery-required");
        return { queue: original, durability: store.durability, receipt: prior };
      }
      if (request.action === "create" && queue.revision !== 0) refuseWork("conflicting-identity");
      if (request.action === "mutate" && request.expectedRevision !== queue.revision)
        refuseWork("conflicting-revision", { currentRevision: queue.revision });
      if (queue.revision >= Number.MAX_SAFE_INTEGER - 2)
        refuseWork("resource-exhausted", { dimension: "storage" });
      const changed = new Map<string, { id: WorkItem["id"]; digest: string }>();
      const at = Math.max(now(), queue.updatedAt);
      const save = (item: WorkItem) => {
        budget.check();
        validateWorkItem(item);
        changed.set(item.id, { id: item.id, digest: workDigest(item) });
        if (changed.size > WORK_QUEUE_LIMITS.batch)
          refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
        tx.putItem(item);
      };
      if (request.action === "create") {
        tx.putQueue(queue);
        if (
          queue.scope.sessionId !== null &&
          tx.binding(queue.scope.sessionId, queue.scope.workspaceId) === null
        )
          tx.bind(queue.scope.sessionId, queue.scope.workspaceId, queue.id);
      } else
        for (const operation of request.operations)
          applyWorkMutation({ tx, queue, operation, authority, budget, now: at, save });
      budget.check();
      authorize(queue, "mutate");
      const updated = { ...queue, revision: queue.revision + 1, updatedAt: at };
      const receipt: WorkReceipt = {
        version: 1,
        queueId: queue.id,
        scopeGeneration: queue.scope.generation,
        mutationId: request.mutationId,
        intent,
        queueDigest: workDigest(updated),
        edgesDigest: tx.edgesDigest(queue.id, updated.revision),
        previousRevision: queue.revision,
        revision: updated.revision,
        actor: authority.actor,
        source: request.source,
        sourceGeneration: request.sourceGeneration,
        reason: request.reason,
        at,
        items: [...changed.values()],
      };
      tx.putQueue(updated);
      tx.appendReceipt(updated, receipt);
      budget.check();
      return { queue: updated, durability: store.durability, receipt };
    }
    if (request.action === "receipt") {
      const receipt = tx.receipt(queue.id, request.mutationId);
      if (receipt === null) refuseWork("recovery-required");
      return { queue, durability: store.durability, receipt };
    }
    if (request.expectedRevision !== queue.revision)
      refuseWork(request.action === "show" ? "conflicting-revision" : "stale-page", {
        currentRevision: queue.revision,
      });
    if (request.action === "show") {
      const item = tx.item(queue.id, request.itemId);
      if (item === null) refuseWork("unavailable");
      return { queue, durability: store.durability, items: [item] };
    }
    if (request.action === "edges") {
      if (tx.item(queue.id, request.itemId) === null) refuseWork("unavailable");
      if (
        request.atRevision !== undefined &&
        (request.atRevision < 1 || request.atRevision > queue.revision)
      )
        refuseWork("stale-page");
      if (request.atRevision !== undefined) {
        const historical = tx.queueAt(queue.id, request.atRevision);
        if (historical === null) refuseWork("recovery-required");
        queue = historical;
      }
      const edges = tx.edges(
        queue.id,
        request.itemId,
        request.direction,
        request.after ?? "",
        request.atRevision,
      );
      return {
        queue,
        durability: store.durability,
        edges,
        next: edges.length === WORK_QUEUE_LIMITS.page ? (edges.at(-1) ?? null) : null,
      };
    }
    if (request.action === "history") {
      const history = tx.history(queue.id, request.afterRevision, request.limit);
      return {
        queue,
        durability: store.durability,
        history,
        next:
          (history.at(-1)?.revision ?? queue.revision) < queue.revision
            ? (history.at(-1)?.revision ?? null)
            : null,
      };
    }
    if (request.action === "replay") {
      const historical = tx.queueAt(queue.id, request.atRevision);
      if (historical === null) refuseWork("stale-page");
      queue = historical;
    }
    const page =
      request.action === "replay"
        ? tx.itemsAt(queue.id, request.atRevision, request.after ?? "", request.limit)
        : tx.items(queue.id, request.after ?? "", request.limit);
    const items: WorkItem[] = [];
    let size = bytes(queue) + 256;
    for (const item of page) {
      budget.step();
      const length = bytes(item);
      if (size + length > WORK_QUEUE_LIMITS.responseBytes) break;
      items.push(item);
      size += length;
    }
    return {
      queue,
      durability: store.durability,
      items,
      next:
        items.length < page.length || page.length === request.limit
          ? (items.at(-1)?.id ?? null)
          : null,
    };
  }
  return {
    async execute(
      json: string,
      signal = new AbortController().signal,
    ): Promise<WorkResult<WorkQueueResponse>> {
      if (signal.aborted) return err({ code: "cancelled-operation" });
      if (typeof json !== "string" || Buffer.byteLength(json) > WORK_QUEUE_LIMITS.requestBytes)
        return err({ code: "resource-exhausted", dimension: "requestBytes" });
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        return err({ code: "malformed" });
      }
      const parsed = workQueueRequestSchema.safeParse(raw);
      if (!parsed.success)
        return err({
          code:
            typeof raw === "object" && raw !== null && "version" in raw && raw.version !== 1
              ? "unsupported"
              : "malformed",
        });
      if (hasSecret(parsed.data)) return err({ code: "denied" });
      const request = parsed.data;
      const duration = Math.min(
        WORK_QUEUE_LIMITS.validationMs,
        options.validationMs ?? WORK_QUEUE_LIMITS.validationMs,
        options.resources.remaining("wallTimeMs"),
      );
      const deadline = now() + duration;
      const observed: { value?: WorkResult<WorkQueueResponse> } = {};
      const execution = await options.resources.execute({
        operation: `work-queue:${randomUUID()}`,
        attempt: randomUUID(),
        generation: options.resources.generation,
        unit: {
          id: workUnitId(`work-queue:${randomUUID()}`),
          effect: "mutation",
          priority: "interactive",
          conflictKeys: [
            conflictKey(
              "work-queue",
              request.action === "resume" ? authority.sessionId : request.queueId,
            ),
          ],
          dependencies: [],
          deadline: deadlineAt(instant(deadline)),
          expectedOutputBytes: WORK_QUEUE_LIMITS.responseBytes,
          retry: NO_RETRY,
          scopeId: null,
        },
        inputBytes: Buffer.byteLength(json),
        amounts: { operations: 1 },
        signal,
        async run(admittedSignal) {
          const value = store.transaction((tx) => {
            const result = perform(tx, request, admittedSignal, deadline);
            if (admittedSignal.aborted) refuseWork("cancelled-operation");
            if (now() >= deadline)
              refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
            if (bytes(result) > WORK_QUEUE_LIMITS.responseBytes)
              refuseWork("resource-exhausted", { dimension: "responseBytes", incomplete: true });
            return result;
          }, admittedSignal);
          observed.value = value;
          return {
            value,
            terminated: true,
            observedEffect: value.ok
              ? ("completed" as const)
              : value.error.code === "recovery-required"
                ? ("uncertain" as const)
                : ("none" as const),
          };
        },
      });
      const result = execution.kind === "completed" ? execution.value : observed.value;
      if (
        result !== undefined &&
        !result.ok &&
        (request.action === "create" || request.action === "mutate")
      ) {
        return err({
          ...result.error,
          source: request.source,
          sourceGeneration: request.sourceGeneration,
        });
      }
      return result !== undefined
        ? result
        : err({
            code: signal.aborted ? "cancelled-operation" : "resource-exhausted",
            dimension: "admission",
            ...(request.action === "create" || request.action === "mutate"
              ? { source: request.source, sourceGeneration: request.sourceGeneration }
              : {}),
          });
    },
  };
}
