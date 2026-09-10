import { dependencyJoinSatisfied, findDependencyCycle } from "./dependency-graph.ts";
import {
  refuseWork,
  WORK_QUEUE_LIMITS,
  type WorkItem,
  type WorkItemId,
  type WorkQueue,
  type WorkQueueAuthority,
  type WorkQueueTransaction,
  workItemSchema,
} from "./work-queue.ts";
import type { WorkMutation } from "./work-queue-requests.ts";

export type WorkValidation = { check(): void; step(): void };

/** Keyset traversal retains only this operation's bounded frontier, never a queue snapshot. */
function* workEdges(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  id: WorkItemId,
  direction: "dependencies" | "dependents",
  budget: WorkValidation,
): Generator<WorkItemId> {
  let after = "";
  for (;;) {
    budget.step();
    const page = tx.edges(queue.id, id, direction, after);
    for (const next of page) {
      budget.step();
      yield next;
      after = next;
    }
    if (page.length < WORK_QUEUE_LIMITS.page) return;
  }
}
export function eachWorkEdge(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  id: WorkItemId,
  direction: "dependencies" | "dependents",
  budget: WorkValidation,
  visit: (id: WorkItemId) => void,
) {
  for (const next of workEdges(tx, queue, id, direction, budget)) visit(next);
}
export function completedWork(item: WorkItem): boolean {
  return (
    !item.deleted &&
    (item.disposition === "completed" ||
      (item.disposition === "archived" && item.previousDisposition === "completed")) &&
    item.acceptance !== null
  );
}
function live(item: WorkItem | null): WorkItem {
  if (item === null || item.deleted) refuseWork("invalid-dependency");
  return item;
}
export function requireReady(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  item: WorkItem,
  budget: WorkValidation,
) {
  if (item.blockers.length > 0 || item.unresolvedDependencies) refuseWork("blocked-transition");
  function* observed() {
    for (const id of workEdges(tx, queue, item.id, "dependencies", budget))
      yield completedWork(live(tx.item(queue.id, id)));
  }
  if (!dependencyJoinSatisfied("all", observed())) refuseWork("blocked-transition");
}
function requireIdle(item: WorkItem) {
  if (
    item.claim !== null ||
    (item.execution !== null && !["settled", "fenced"].includes(item.execution.state))
  )
    refuseWork("blocked-transition");
}
function mutable(item: WorkItem) {
  if (item.deleted || ["completed", "cancelled", "archived"].includes(item.disposition))
    refuseWork("blocked-transition");
}
export function validateWorkItem(item: WorkItem) {
  const parsed = workItemSchema.safeParse(item);
  if (!parsed.success) refuseWork("malformed");
  const fields = [
    item.subject,
    item.description,
    item.objective,
    item.activeForm,
    item.criteria,
    item.blockers,
    item.reason,
    item.metadata,
  ];
  if (
    new TextEncoder().encode(JSON.stringify(fields)).length > WORK_QUEUE_LIMITS.inlineBytes ||
    new TextEncoder().encode(JSON.stringify(item)).length > WORK_QUEUE_LIMITS.recordBytes
  )
    refuseWork("resource-exhausted", { dimension: "inlineBytes" });
}

export function applyWorkMutation(input: {
  tx: WorkQueueTransaction;
  queue: WorkQueue;
  operation: WorkMutation;
  authority: WorkQueueAuthority;
  budget: WorkValidation;
  now: number;
  save(item: WorkItem): void;
}) {
  const { tx, queue, operation: op, authority, budget, now, save } = input;
  budget.step();
  const found = tx.item(queue.id, op.itemId);
  if (op.kind === "add") {
    if (found !== null) refuseWork("conflicting-identity");
    if (op.fields.agentType !== null && !authority.registeredAgent(op.fields.agentType))
      refuseWork("unsupported");
    save({
      ...op.fields,
      version: 1,
      id: op.itemId,
      queueId: queue.id,
      revision: queue.revision + 1,
      criteriaRevision: 1,
      disposition: "pending",
      previousDisposition: null,
      reason: null,
      blockers: [],
      unresolvedDependencies: false,
      claimGeneration: 0,
      claim: null,
      execution: null,
      evidence: [],
      acceptance: null,
      deleted: false,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  let item = live(found);
  const finish = (next: WorkItem) =>
    save({ ...next, revision: queue.revision + 1, updatedAt: now });
  switch (op.kind) {
    case "update": {
      mutable(item);
      if (op.fields.agentType != null && !authority.registeredAgent(op.fields.agentType))
        refuseWork("unsupported");
      const changesMeaning =
        op.fields.criteria !== undefined ||
        op.fields.objective !== undefined ||
        op.fields.description !== undefined ||
        op.fields.subject !== undefined ||
        op.fields.agentType !== undefined;
      if (changesMeaning) requireIdle(item);
      const metadata = { ...item.metadata };
      for (const [key, value] of Object.entries(op.fields.metadata ?? {})) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      item = {
        ...item,
        subject: op.fields.subject ?? item.subject,
        description: op.fields.description ?? item.description,
        objective: op.fields.objective ?? item.objective,
        activeForm: op.fields.activeForm === undefined ? item.activeForm : op.fields.activeForm,
        agentType: op.fields.agentType === undefined ? item.agentType : op.fields.agentType,
        criteria: op.fields.criteria ?? item.criteria,
        metadata,
      };
      if (changesMeaning)
        item = {
          ...item,
          criteriaRevision: item.criteriaRevision + 1,
          unresolvedDependencies:
            op.fields.criteria === undefined ? item.unresolvedDependencies : false,
          evidence: [],
          acceptance: null,
          disposition: "pending",
        };
      finish(item);
      return;
    }
    case "link":
    case "unlink": {
      mutable(item);
      requireIdle(item);
      const dependency = live(tx.item(queue.id, op.dependency));
      if (op.dependency === item.id) refuseWork("invalid-dependency");
      if (op.kind === "unlink") {
        let exists = false;
        eachWorkEdge(tx, queue, item.id, "dependencies", budget, (id) => {
          if (id === dependency.id) exists = true;
        });
        if (!exists) refuseWork("invalid-dependency");
      }
      if (op.kind === "link") {
        function* dependencies(id: WorkItemId) {
          if (id === item.id) yield dependency.id;
          yield* workEdges(tx, queue, id, "dependencies", budget);
        }
        if (findDependencyCycle([item.id], dependencies) !== null) refuseWork("invalid-dependency");
      }
      tx.setEdge(queue.id, { item: item.id, dependency: dependency.id }, op.kind === "link");
      finish({
        ...item,
        disposition: "pending",
        evidence: [],
        acceptance: null,
        unresolvedDependencies:
          item.unresolvedDependencies || (op.kind === "unlink" && !completedWork(dependency)),
      });
      return;
    }
    case "blockers":
      mutable(item);
      requireIdle(item);
      finish({
        ...item,
        blockers: op.blockers,
        disposition: op.blockers.length ? "blocked" : "pending",
        previousDisposition: op.blockers.length
          ? item.disposition === "ready"
            ? "ready"
            : "pending"
          : null,
        evidence: [],
        reason: op.blockers[0] ?? null,
      });
      return;
    case "disposition":
      mutable(item);
      if (["ready", "active"].includes(op.value)) requireReady(tx, queue, item, budget);
      if (
        op.value === "active" &&
        (item.claim === null ||
          item.claim.releasePending ||
          !authority.admitHolder(item.claim.holder))
      )
        refuseWork("denied");
      if (op.value !== "active") requireIdle(item);
      finish({
        ...item,
        disposition: op.value,
        reason: op.reason,
        previousDisposition: ["waiting", "blocked"].includes(op.value)
          ? item.disposition === "ready"
            ? "ready"
            : "pending"
          : null,
      });
      return;
    case "claim":
      mutable(item);
      requireIdle(item);
      requireReady(tx, queue, item, budget);
      if (!authority.admitHolder(op.holder)) refuseWork("denied");
      finish({
        ...item,
        disposition: "active",
        claimGeneration: item.claimGeneration + 1,
        claim: { generation: item.claimGeneration + 1, holder: op.holder, releasePending: false },
        execution: null,
        evidence: [],
        acceptance: null,
      });
      return;
    case "release":
    case "reconcile": {
      if (item.claim === null) refuseWork("blocked-transition");
      const observation = authority.observeExecution(item);
      if (
        observation !== null &&
        item.execution !== null &&
        (observation.id !== item.execution.id ||
          observation.generation !== item.execution.generation)
      )
        refuseWork("stale-evidence");
      // Unknown is not idle: an admitted holder may have started work before the crash.
      const stopped = observation !== null && ["settled", "fenced"].includes(observation.state);
      if (op.kind === "release" && item.claim.holder.actor !== authority.actor)
        refuseWork("denied");
      finish({
        ...item,
        execution: observation ?? item.execution,
        claim: stopped ? null : { ...item.claim, releasePending: true },
        disposition:
          item.disposition === "cancelled" ? "cancelled" : stopped ? "pending" : "waiting",
        reason: stopped ? "execution-settled" : "execution-reconciliation-required",
      });
      return;
    }
    case "submit":
      mutable(item);
      requireReady(tx, queue, item, budget);
      if (
        op.claimGeneration !== item.claimGeneration ||
        op.criteriaRevision !== item.criteriaRevision ||
        (item.claim !== null &&
          (item.claim.holder.actor !== authority.actor || item.claim.releasePending))
      )
        refuseWork("stale-evidence");
      finish({ ...item, disposition: "completion-claimed", evidence: op.evidence });
      return;
    case "validate": {
      requireReady(tx, queue, item, budget);
      if (
        item.disposition !== "completion-claimed" ||
        op.itemRevision !== item.revision ||
        op.claimGeneration !== item.claimGeneration ||
        op.criteriaRevision !== item.criteriaRevision ||
        JSON.stringify(op.evidence) !== JSON.stringify(item.evidence)
      )
        refuseWork("stale-evidence");
      if (
        !authority.validateCompletion({
          queue,
          item,
          authority: op.authority,
          verdict: op.verdict,
          reason: op.reason,
        })
      )
        refuseWork("denied");
      if (op.verdict === "refuse") {
        finish({ ...item, reason: op.reason });
        return;
      }
      const observation = item.claim === null ? item.execution : authority.observeExecution(item);
      if (
        item.claim !== null &&
        (observation === null || !["settled", "fenced"].includes(observation.state))
      )
        refuseWork("blocked-transition");
      if (
        item.execution !== null &&
        observation !== null &&
        (item.execution.id !== observation.id ||
          item.execution.generation !== observation.generation)
      )
        refuseWork("stale-evidence");
      finish({
        ...item,
        disposition: "completed",
        claim: null,
        execution: observation,
        acceptance: {
          actor: authority.actor,
          authority: op.authority,
          reason: op.reason,
          criteriaRevision: item.criteriaRevision,
        },
      });
      return;
    }
    case "cancel":
      mutable(item);
      finish({ ...item, disposition: "cancelled", reason: "record-cancelled" });
      return;
    case "archive":
      requireIdle(item);
      if (!["completed", "cancelled"].includes(item.disposition)) refuseWork("blocked-transition");
      finish({ ...item, disposition: "archived", previousDisposition: item.disposition });
      return;
    case "delete":
      requireIdle(item);
      eachWorkEdge(tx, queue, item.id, "dependents", budget, (id) => {
        const dependent = live(tx.item(queue.id, id));
        requireIdle(dependent);
        if (completedWork(dependent)) refuseWork("blocked-transition");
        tx.setEdge(queue.id, { item: id, dependency: item.id }, false);
        save({
          ...dependent,
          unresolvedDependencies: true,
          disposition: "blocked",
          reason: "dependency-deleted",
          revision: queue.revision + 1,
          updatedAt: now,
        });
      });
      eachWorkEdge(tx, queue, item.id, "dependencies", budget, (id) =>
        tx.setEdge(queue.id, { item: item.id, dependency: id }, false),
      );
      finish({ ...item, deleted: true });
      return;
  }
}
