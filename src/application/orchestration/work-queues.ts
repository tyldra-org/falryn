import { createHash, randomUUID } from "node:crypto";
import { deadlineAt, instant } from "../../domain/foundation/index.ts";
import { err } from "../../domain/foundation/result.ts";
import { canonicalResourceValue } from "../../domain/orchestration/resource-admission.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  ancestorsOf,
  applyHierarchyMutation,
  expandWorkSelection,
  liveChildren,
  nextInSubtree,
  placementOf,
  removalPlan,
  type WorkNode,
  type WorkProgress,
  workNode,
  workProgress,
} from "../../domain/orchestration/work-hierarchy.ts";
import {
  refuseWork,
  WORK_QUEUE_LIMITS,
  type WorkGroup,
  type WorkItem,
  type WorkItemId,
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
  isHierarchyMutation,
  type WorkQueueRequest,
  workQueueRequestSchema,
} from "../../domain/orchestration/work-queue-requests.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";
import type { ProductTaskResources } from "./product-resources.ts";

export const workDigest = (value: unknown) =>
  createHash("sha256").update(canonicalResourceValue(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** A hierarchy node as a version 2 client sees it; order keys stay inside the store. */
export type WorkNodeView =
  | { readonly kind: "task"; readonly parentId: WorkItemId | null; readonly item: WorkItem }
  | { readonly kind: "group"; readonly parentId: WorkItemId | null; readonly group: WorkGroup };
/**
 * Committed task lifecycle facts for observers such as hooks. Group changes and
 * executor termination are never task acceptance.
 */
export type WorkTaskFact = {
  readonly kind: "task-created" | "task-accepted";
  readonly node: "task";
  readonly id: WorkItemId;
  readonly queueId: WorkQueue["id"];
  readonly revision: number;
  readonly mutationId: string;
  readonly actor: string;
  readonly source: string;
  readonly sourceGeneration: string;
};
export type WorkQueueResponse = {
  readonly queue: WorkQueue | null;
  readonly durability: "ephemeral" | "durable";
  readonly receipt?: WorkReceipt;
  readonly items?: readonly WorkItem[];
  readonly nodes?: readonly WorkNodeView[];
  readonly progress?: WorkProgress;
  readonly manifest?: ReturnType<typeof expandWorkSelection>;
  readonly plan?: ReturnType<typeof removalPlan>;
  readonly edges?: readonly string[];
  readonly history?: readonly WorkReceipt[];
  readonly next?: string | number | null;
  /** Present only on the commit that produced them; a replayed receipt carries none. */
  readonly facts?: readonly WorkTaskFact[];
  readonly observer?: "delivered" | "failed";
};
function viewOf(tx: WorkQueueTransaction, queue: WorkQueue, node: WorkNode): WorkNodeView {
  const id = node.kind === "task" ? node.item.id : node.group.id;
  const parentId = placementOf(tx, queue, id).parent;
  return node.kind === "task"
    ? { kind: "task", parentId, item: node.item }
    : { kind: "group", parentId, group: node.group };
}

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
    /**
     * Called after a commit, outside the storage transaction, with that commit's
     * task facts. Its failure never changes the committed mutation, and replayed
     * receipts never call it again.
     */
    readonly observe?: (facts: readonly WorkTaskFact[]) => void | Promise<void>;
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
      const groups = new Map<string, { id: WorkItem["id"]; digest: string }>();
      const before = new Map<string, WorkItem | null>();
      const affected = new Set<WorkItemId>();
      let placed = false;
      const at = Math.max(now(), queue.updatedAt);
      const save = (item: WorkItem) => {
        budget.check();
        validateWorkItem(item);
        if (!before.has(item.id)) before.set(item.id, tx.item(item.queueId, item.id));
        changed.set(item.id, { id: item.id, digest: workDigest(item) });
        if (changed.size > WORK_QUEUE_LIMITS.batch)
          refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
        tx.putItem(item);
      };
      const current = queue;
      const effects = {
        saveGroup(group: WorkGroup) {
          budget.check();
          if (bytes(group) > WORK_QUEUE_LIMITS.recordBytes)
            refuseWork("resource-exhausted", { dimension: "inlineBytes" });
          groups.set(group.id, { id: group.id, digest: workDigest(group) });
          affected.add(group.id);
          if (groups.size > WORK_QUEUE_LIMITS.batch)
            refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
          tx.putGroup(group);
        },
        place(node: WorkItemId, placement: { parent: WorkItemId | null; order: string }) {
          budget.step();
          placed = true;
          tx.setPlacement(current.id, node, placement);
        },
        affect(ids: readonly WorkItemId[]) {
          for (const id of ids) affected.add(id);
        },
        deleteTask(itemId: WorkItemId) {
          applyWorkMutation({
            tx,
            queue: current,
            operation: { kind: "delete", itemId },
            authority,
            budget,
            now: at,
            save,
          });
        },
      };
      if (request.action === "create") {
        tx.putQueue(queue);
        if (
          queue.scope.sessionId !== null &&
          tx.binding(queue.scope.sessionId, queue.scope.workspaceId) === null
        )
          tx.bind(queue.scope.sessionId, queue.scope.workspaceId, queue.id);
      } else
        for (const operation of request.operations) {
          if (isHierarchyMutation(operation))
            applyHierarchyMutation({
              tx,
              queue,
              operation,
              actor: authority.actor,
              source: request.source,
              sourceGeneration: request.sourceGeneration,
              budget,
              now: at,
              effects,
            });
          else applyWorkMutation({ tx, queue, operation, authority, budget, now: at, save });
        }
      budget.check();
      const hierarchical = placed || groups.size > 0;
      // Derived progress of every group above a changed task may change too.
      if (hierarchical)
        for (const id of changed.keys()) {
          // An invalidation hint, not a validation: stop at a parent removed in this batch.
          let parent = tx.placement(queue.id, id as WorkItemId)?.parent ?? null;
          while (parent !== null && !affected.has(parent)) {
            budget.step();
            const group = tx.group(queue.id, parent);
            if (group === null || group.deleted) break;
            affected.add(parent);
            parent = tx.placement(queue.id, parent)?.parent ?? null;
          }
        }
      authorize(queue, "mutate");
      const updated = { ...queue, revision: queue.revision + 1, updatedAt: at };
      const common = {
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
      const liveGroups = [...affected].filter((id) => {
        const group = tx.group(current.id, id);
        return group !== null;
      });
      const receipt: WorkReceipt = hierarchical
        ? {
            version: 2,
            ...common,
            groups: [...groups.values()],
            placementsDigest: tx.placementsDigest(queue.id, updated.revision),
            affected: {
              // Bounded so a full batch still fits one receipt row.
              groups: liveGroups.slice(0, 64),
              complete: liveGroups.length <= 64,
            },
          }
        : { version: 1, ...common };
      tx.appendReceipt(updated, receipt);
      budget.check();
      const facts: WorkTaskFact[] = [];
      for (const [id] of changed) {
        const prior = before.get(id) ?? null;
        const next = tx.item(queue.id, id as WorkItemId);
        if (next === null) continue;
        const fact = {
          node: "task" as const,
          id: next.id,
          queueId: queue.id,
          revision: updated.revision,
          mutationId: request.mutationId,
          actor: authority.actor,
          source: request.source,
          sourceGeneration: request.sourceGeneration,
        };
        if (prior === null) facts.push({ kind: "task-created", ...fact });
        if (next.disposition === "completed" && prior?.disposition !== "completed")
          facts.push({ kind: "task-accepted", ...fact });
      }
      return { queue: updated, durability: store.durability, receipt, facts };
    }
    if (request.action === "receipt") {
      const receipt = tx.receipt(queue.id, request.mutationId);
      if (receipt === null) refuseWork("recovery-required");
      return { queue, durability: store.durability, receipt };
    }
    if (request.expectedRevision !== queue.revision)
      refuseWork(
        ["show", "node"].includes(request.action) ? "conflicting-revision" : "stale-page",
        {
          currentRevision: queue.revision,
        },
      );
    const pinned: WorkQueue = queue;
    if (request.action === "node" || request.action === "ancestors") {
      const node = workNode(tx, pinned, request.nodeId);
      if (node === null) refuseWork("unavailable");
      if (request.action === "node")
        return { queue: pinned, durability: store.durability, nodes: [viewOf(tx, pinned, node)] };
      const nodes = ancestorsOf(tx, pinned, request.nodeId, budget)
        .reverse()
        .map((id) => {
          const group = workNode(tx, pinned, id);
          if (group === null) refuseWork("corrupt");
          return viewOf(tx, pinned, group);
        });
      return { queue: pinned, durability: store.durability, nodes };
    }
    if (request.action === "children" || request.action === "subtree") {
      const nodes: WorkNodeView[] = [];
      let size = bytes(pinned) + 256;
      let more = false;
      const push = (node: WorkNode) => {
        const view = viewOf(tx, pinned, node);
        const length = bytes(view);
        if (nodes.length >= request.limit || size + length > WORK_QUEUE_LIMITS.responseBytes)
          return false;
        nodes.push(view);
        size += length;
        return true;
      };
      if (request.action === "children") {
        if (request.parentId !== null) {
          const parent = workNode(tx, pinned, request.parentId);
          if (parent === null || parent.kind !== "group" || parent.group.deleted)
            refuseWork(parent?.kind === "task" ? "invalid-hierarchy" : "unavailable");
        }
        let after = null;
        if (request.after !== null) {
          const placement = placementOf(tx, pinned, request.after);
          if (placement.parent !== request.parentId) refuseWork("stale-page");
          after = { id: request.after, order: placement.order };
        }
        for (const child of liveChildren(tx, pinned, request.parentId, budget, after))
          if (!push(child.node)) {
            more = true;
            break;
          }
      } else {
        const root = workNode(tx, pinned, request.groupId);
        if (root === null || root.kind !== "group" || root.group.deleted)
          refuseWork(root?.kind === "task" ? "invalid-hierarchy" : "unavailable");
        if (
          request.after !== null &&
          !ancestorsOf(tx, pinned, request.after, budget).includes(request.groupId)
        )
          refuseWork("stale-page");
        let cursor = request.after;
        for (;;) {
          const next = nextInSubtree(tx, pinned, request.groupId, cursor, budget);
          if (next === null) break;
          if (!push(next.node)) {
            more = true;
            break;
          }
          cursor = next.id;
        }
      }
      const last = nodes.at(-1);
      return {
        queue: pinned,
        durability: store.durability,
        nodes,
        next:
          more && last !== undefined ? (last.kind === "task" ? last.item.id : last.group.id) : null,
      };
    }
    if (request.action === "progress")
      return {
        queue: pinned,
        durability: store.durability,
        progress: workProgress(tx, pinned, request.groupId, budget, request.after ?? null),
      };
    if (request.action === "expand")
      return {
        queue: pinned,
        durability: store.durability,
        manifest: expandWorkSelection(tx, pinned, request, budget),
      };
    if (request.action === "removal-plan")
      return {
        queue: pinned,
        durability: store.durability,
        plan: removalPlan(tx, pinned, request.groupId, budget),
      };
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
            typeof raw === "object" &&
            raw !== null &&
            "version" in raw &&
            raw.version !== 1 &&
            raw.version !== 2
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
      let result = execution.kind === "completed" ? execution.value : observed.value;
      const facts = result?.ok ? result.value.facts : undefined;
      if (result?.ok && facts !== undefined && facts.length > 0 && options.observe) {
        // Outside the storage transaction: observers see committed facts and cannot undo them.
        let observer: "delivered" | "failed" = "delivered";
        try {
          await options.observe(facts);
        } catch {
          observer = "failed";
        }
        result = { ok: true, value: { ...result.value, observer } };
      }
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
