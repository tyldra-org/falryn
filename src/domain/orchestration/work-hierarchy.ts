/**
 * Todo hierarchy over the scoped work-item store.
 *
 * Three relations stay separate: placement (a single-parent forest of groups
 * and tasks with ordered siblings), dependency edges (a task-to-task DAG) and
 * execution. Groups organize; they are never claimed, run, depended on or
 * completed. Progress is derived from descendant tasks at one queue revision
 * and is never an accepted fact of its own.
 */

import {
  refuseWork,
  WORK_QUEUE_LIMITS,
  type WorkChild,
  type WorkGroup,
  type WorkItem,
  type WorkItemId,
  type WorkPlacement,
  type WorkQueue,
  WorkQueueRefusal,
  type WorkQueueTransaction,
  workGroupSchema,
} from "./work-queue.ts";
import { completedWork, type WorkValidation } from "./work-queue-mutations.ts";
import type { WorkHierarchyMutation, WorkPosition } from "./work-queue-requests.ts";

/** Longest opaque order key before the store respaces a sibling list. */
export const ORDER_KEY_MAX = 128;
const MIN = 33; // "!"
const MAX = 126; // "~"
const BELOW = MIN - 1;
const ABOVE = MAX + 1;
const char = (code: number) => String.fromCharCode(code);

/**
 * A key strictly between two sibling keys (either may be absent).
 *
 * Keys use printable ASCII and never end in the lowest character, so there is
 * always room before any key. Task IDs, which order implicit root tasks, use
 * the same alphabet and cannot end in "!".
 */
export function orderKeyBetween(low: string | null, high: string | null): string {
  if (low !== null && high !== null && low >= high) throw new Error("order-key-range");
  let prefix = "";
  let upper = high;
  for (let index = 0; ; index += 1) {
    const a = low !== null && index < low.length ? low.charCodeAt(index) : BELOW;
    const b = upper !== null && index < upper.length ? upper.charCodeAt(index) : ABOVE;
    if (a === b) {
      prefix += char(a);
      continue;
    }
    if (b - a > 1) {
      const middle = Math.floor((a + b) / 2);
      return middle === MIN
        ? `${prefix}${char(MIN)}${char((MIN + MAX) >> 1)}`
        : prefix + char(middle);
    }
    if (a === BELOW) {
      // `high` has the lowest character here and continues; follow it down.
      prefix += char(b);
      continue;
    }
    prefix += char(a);
    upper = null;
  }
}

/** Evenly spaced short keys for `count` siblings, used when keys grow too long. */
export function spreadOrderKeys(count: number): string[] {
  const base = BigInt(MAX - MIN + 1);
  let width = 1;
  while (base ** BigInt(width) <= BigInt(count + 1) * 2n) width += 1;
  const span = base ** BigInt(width);
  return Array.from({ length: count }, (_, index) => {
    let value = ((BigInt(index) + 1n) * span) / BigInt(count + 1);
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = char(Number(value % base) + MIN) + key;
      value /= base;
    }
    return key.endsWith(char(MIN)) ? `${key}${char((MIN + MAX) >> 1)}` : key;
  });
}

export type WorkNode =
  | { readonly kind: "task"; readonly item: WorkItem }
  | { readonly kind: "group"; readonly group: WorkGroup };

export function workNode(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  id: WorkItemId,
): WorkNode | null {
  const item = tx.item(queue.id, id);
  if (item !== null) return { kind: "task", item };
  const group = tx.group(queue.id, id);
  return group === null ? null : { kind: "group", group };
}
const deleted = (node: WorkNode) => (node.kind === "task" ? node.item.deleted : node.group.deleted);

export function placementOf(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  id: WorkItemId,
): WorkPlacement {
  const recorded = tx.placement(queue.id, id);
  if (recorded !== null) return recorded;
  // Only tasks may be implicit roots; a group always records where it was created.
  if (tx.group(queue.id, id) !== null) refuseWork("corrupt");
  return { parent: null, order: id };
}

/** Every sibling (including tombstones) in order, one bounded page at a time. */
function* childrenOf(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  parent: WorkItemId | null,
  budget: WorkValidation,
  after: WorkChild | null = null,
): Generator<WorkChild> {
  let cursor = after;
  for (;;) {
    budget.step();
    const page = tx.children(queue.id, parent, cursor, WORK_QUEUE_LIMITS.page);
    for (const child of page) {
      budget.step();
      yield child;
      cursor = child;
    }
    if (page.length < WORK_QUEUE_LIMITS.page) return;
  }
}

/** Live children in order. A child whose record is missing is corruption, never skipped. */
export function* liveChildren(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  parent: WorkItemId | null,
  budget: WorkValidation,
  after: WorkChild | null = null,
): Generator<WorkChild & { readonly node: WorkNode }> {
  for (const child of childrenOf(tx, queue, parent, budget, after)) {
    const node = workNode(tx, queue, child.id);
    if (node === null) refuseWork("corrupt");
    if (!deleted(node)) yield { ...child, node };
  }
}

/** Parent chain from the node's parent up to the root, each a live group. */
export function ancestorsOf(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  id: WorkItemId,
  budget: WorkValidation,
): WorkItemId[] {
  const chain: WorkItemId[] = [];
  let parent = placementOf(tx, queue, id).parent;
  while (parent !== null) {
    budget.step();
    const group = tx.group(queue.id, parent);
    // A live node under a missing or removed parent needs a validated repair.
    if (group === null || group.deleted) refuseWork("recovery-required");
    if (chain.includes(parent) || chain.length >= WORK_QUEUE_LIMITS.depth) refuseWork("corrupt");
    chain.push(parent);
    parent = placementOf(tx, queue, parent).parent;
  }
  return chain;
}

function subtreeHeight(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  group: WorkItemId,
  budget: WorkValidation,
): number {
  let height = 1;
  for (const child of liveChildren(tx, queue, group, budget))
    if (child.node.kind === "group")
      height = Math.max(height, 1 + subtreeHeight(tx, queue, child.id, budget));
  return height;
}

function liveGroup(tx: WorkQueueTransaction, queue: WorkQueue, id: WorkItemId): WorkGroup {
  const group = tx.group(queue.id, id);
  if (group === null || group.deleted) {
    if (tx.item(queue.id, id) !== null) refuseWork("invalid-hierarchy");
    refuseWork("unavailable");
  }
  return group;
}

/** Resolves a placement request to a concrete key among the target's live siblings. */
function positionKey(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  parent: WorkItemId | null,
  node: WorkItemId,
  position: WorkPosition,
  budget: WorkValidation,
): string | "respace" {
  const siblingKey = (id: WorkItemId) => {
    if (id === node) refuseWork("invalid-hierarchy");
    const found = workNode(tx, queue, id);
    if (found === null || deleted(found)) refuseWork("unavailable");
    const placement = placementOf(tx, queue, id);
    if (placement.parent !== parent) refuseWork("invalid-hierarchy");
    return { id, order: placement.order };
  };
  const neighbour = (from: WorkChild, direction: "forward" | "backward") => {
    for (const next of tx.children(queue.id, parent, from, 2, direction)) {
      budget.step();
      if (next.id !== node) return next.order;
    }
    return null;
  };
  let low: string | null;
  let high: string | null;
  if (position.at === "end") {
    const last = tx.children(queue.id, parent, null, 2, "backward").find((c) => c.id !== node);
    budget.step();
    low = last?.order ?? null;
    high = null;
  } else if (position.at === "before") {
    const sibling = siblingKey(position.sibling);
    high = sibling.order;
    low = neighbour(sibling, "backward");
  } else {
    const sibling = siblingKey(position.sibling);
    low = sibling.order;
    high = neighbour(sibling, "forward");
  }
  // Equal neighbouring keys (a tie broken by ID) leave no room between them.
  if (low !== null && high !== null && low >= high) return "respace";
  const key = orderKeyBetween(low, high);
  return key.length > ORDER_KEY_MAX ? "respace" : key;
}

export type HierarchyEffects = {
  saveGroup(group: WorkGroup): void;
  place(node: WorkItemId, placement: WorkPlacement): void;
  /** Groups whose derived progress may change. */
  affect(groups: readonly WorkItemId[]): void;
  deleteTask(id: WorkItemId): void;
};

/** Rewrites every sibling of `parent` (tombstones included) to evenly spaced keys. */
function respace(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  parent: WorkItemId | null,
  budget: WorkValidation,
  effects: HierarchyEffects,
) {
  const siblings = [...childrenOf(tx, queue, parent, budget)];
  const keys = spreadOrderKeys(siblings.length);
  for (const [index, sibling] of siblings.entries())
    effects.place(sibling.id, { parent, order: keys[index] ?? sibling.order });
}

function placeNode(input: {
  tx: WorkQueueTransaction;
  queue: WorkQueue;
  node: WorkItemId;
  kind: WorkNode["kind"];
  parent: WorkItemId | null;
  position: WorkPosition;
  budget: WorkValidation;
  effects: HierarchyEffects;
}) {
  const { tx, queue, node, parent, budget, effects } = input;
  let depth = 1;
  if (parent !== null) {
    if (parent === node) refuseWork("invalid-hierarchy");
    liveGroup(tx, queue, parent);
    const ancestors = ancestorsOf(tx, queue, parent, budget);
    // Moving a group under its own descendant would close a cycle.
    if (ancestors.includes(node)) refuseWork("invalid-hierarchy");
    depth = ancestors.length + 2;
  }
  const height = input.kind === "group" ? subtreeHeight(tx, queue, node, budget) : 1;
  if (depth + height - 1 > WORK_QUEUE_LIMITS.depth) refuseWork("invalid-hierarchy");
  let key = positionKey(tx, queue, parent, node, input.position, budget);
  if (key === "respace") {
    respace(tx, queue, parent, budget, effects);
    key = positionKey(tx, queue, parent, node, input.position, budget);
    if (key === "respace") refuseWork("resource-exhausted", { dimension: "storage" });
  }
  effects.place(node, { parent, order: key });
}

export function applyHierarchyMutation(input: {
  tx: WorkQueueTransaction;
  queue: WorkQueue;
  operation: WorkHierarchyMutation;
  actor: string;
  source: string;
  sourceGeneration: string;
  budget: WorkValidation;
  now: number;
  effects: HierarchyEffects;
}) {
  const { tx, queue, operation: op, budget, now, effects } = input;
  budget.step();
  const revision = queue.revision + 1;
  switch (op.kind) {
    case "group": {
      if (tx.item(queue.id, op.groupId) !== null || tx.group(queue.id, op.groupId) !== null)
        refuseWork("conflicting-identity");
      const group: WorkGroup = {
        version: 1,
        kind: "group",
        id: op.groupId,
        queueId: queue.id,
        revision,
        subject: op.subject,
        source: input.source,
        sourceGeneration: input.sourceGeneration,
        actor: input.actor,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };
      if (!workGroupSchema.safeParse(group).success) refuseWork("malformed");
      effects.saveGroup(group);
      placeNode({
        ...input,
        node: op.groupId,
        kind: "group",
        parent: op.parentId,
        position: op.position,
      });
      if (op.parentId !== null)
        effects.affect([op.parentId, ...ancestorsOf(tx, queue, op.parentId, budget)]);
      return;
    }
    case "place": {
      const node = workNode(tx, queue, op.nodeId);
      if (node === null || deleted(node)) refuseWork("unavailable");
      // Organization only: claims, criteria, executors and frozen selections are untouched.
      effects.affect(ancestorsOf(tx, queue, op.nodeId, budget));
      placeNode({
        ...input,
        node: op.nodeId,
        kind: node.kind,
        parent: op.parentId,
        position: op.position,
      });
      effects.affect(ancestorsOf(tx, queue, op.nodeId, budget));
      return;
    }
    case "rename": {
      const group = liveGroup(tx, queue, op.groupId);
      effects.saveGroup({ ...group, subject: op.subject, revision, updatedAt: now });
      return;
    }
    case "remove-group": {
      const group = liveGroup(tx, queue, op.groupId);
      for (const _child of liveChildren(tx, queue, op.groupId, budget))
        refuseWork("blocked-transition");
      effects.affect(ancestorsOf(tx, queue, op.groupId, budget));
      effects.saveGroup({ ...group, deleted: true, revision, updatedAt: now });
      return;
    }
    case "remove-subtree": {
      liveGroup(tx, queue, op.groupId);
      const plan = removalOrder(tx, queue, op.groupId, budget, WORK_QUEUE_LIMITS.batch);
      if (!plan.complete)
        refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
      const reviewed = new Set(op.reviewed);
      if (
        reviewed.size !== plan.nodes.length ||
        plan.nodes.some((entry) => !reviewed.has(entry.id))
      )
        refuseWork("stale-evidence");
      effects.affect(ancestorsOf(tx, queue, op.groupId, budget));
      for (const entry of plan.nodes) {
        if (entry.kind === "task") effects.deleteTask(entry.id);
        else {
          const group = liveGroup(tx, queue, entry.id);
          effects.saveGroup({ ...group, deleted: true, revision, updatedAt: now });
        }
      }
      return;
    }
  }
}

/** Live subtree in post-order (children before their group), up to `limit` nodes. */
export function removalOrder(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  root: WorkItemId,
  budget: WorkValidation,
  limit: number,
): { nodes: { id: WorkItemId; kind: WorkNode["kind"] }[]; complete: boolean } {
  const nodes: { id: WorkItemId; kind: WorkNode["kind"] }[] = [];
  const visit = (id: WorkItemId): boolean => {
    for (const child of liveChildren(tx, queue, id, budget)) {
      if (child.node.kind === "group") {
        if (!visit(child.id)) return false;
      } else {
        if (nodes.length >= limit) return false;
        nodes.push({ id: child.id, kind: "task" });
      }
    }
    if (nodes.length >= limit) return false;
    nodes.push({ id, kind: "group" });
    return true;
  };
  return { nodes, complete: visit(root) };
}

/** Explicit batches that remove a large subtree deepest-first; each is one transaction. */
export function removalPlan(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  root: WorkItemId,
  budget: WorkValidation,
) {
  liveGroup(tx, queue, root);
  const order = removalOrder(tx, queue, root, budget, WORK_QUEUE_LIMITS.traversalSteps);
  if (!order.complete)
    refuseWork("resource-exhausted", { dimension: "validation", incomplete: true });
  const batches: (
    | { kind: "delete"; itemId: WorkItemId }
    | { kind: "remove-group"; groupId: WorkItemId }
  )[][] = [];
  for (let start = 0; start < order.nodes.length; start += WORK_QUEUE_LIMITS.batch)
    batches.push(
      order.nodes
        .slice(start, start + WORK_QUEUE_LIMITS.batch)
        .map((entry) =>
          entry.kind === "task"
            ? { kind: "delete" as const, itemId: entry.id }
            : { kind: "remove-group" as const, groupId: entry.id },
        ),
    );
  return { groupId: root, revision: queue.revision, nodes: order.nodes.length, batches };
}

export const PROGRESS_DISPOSITIONS = [
  "pending",
  "ready",
  "active",
  "waiting",
  "blocked",
  "completion-claimed",
  "completed",
  "cancelled",
] as const;
export type WorkProgress = {
  readonly revision: number;
  readonly total: number;
  /** Partitions `total` using each archived task's disposition before archiving. */
  readonly dispositions: Readonly<Record<(typeof PROGRESS_DISPOSITIONS)[number], number>>;
  /** Also counted in `dispositions`; a visibility fact, not another disposition. */
  readonly archived: number;
  /** Tasks with current accepted completion, archived ones included. */
  readonly accepted: number;
  /** Execution facts kept apart from dispositions. */
  readonly executionUncertain: number;
  readonly groups: number;
  /** `partial` whenever this page does not cover the whole subtree. */
  readonly state: "empty" | "all-completed" | "in-progress" | "partial";
  /**
   * `next` continues a partial count in pre-order at the same revision. Pages
   * of one revision sum to the exact total; a changed revision refuses as stale.
   */
  readonly coverage: { readonly complete: boolean; readonly next: WorkItemId | null };
};

/** Accepted/total over descendant tasks at one revision; exact, or partial with a continuation. */
export function workProgress(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  root: WorkItemId | null,
  budget: WorkValidation,
  after: WorkItemId | null = null,
): WorkProgress {
  if (root !== null) liveGroup(tx, queue, root);
  const dispositions = Object.fromEntries(PROGRESS_DISPOSITIONS.map((d) => [d, 0])) as Record<
    (typeof PROGRESS_DISPOSITIONS)[number],
    number
  >;
  let total = 0;
  let archived = 0;
  let accepted = 0;
  let executionUncertain = 0;
  let groups = 0;
  let cursor = after;
  let complete = false;
  try {
    for (;;) {
      const next = nextInSubtree(tx, queue, root, cursor, budget);
      if (next === null) {
        complete = true;
        break;
      }
      if (next.node.kind === "group") groups += 1;
      else {
        const item = next.node.item;
        total += 1;
        const disposition =
          item.disposition === "archived"
            ? (item.previousDisposition ?? "completed")
            : item.disposition;
        if (item.disposition === "archived") archived += 1;
        if (disposition !== "archived") dispositions[disposition] += 1;
        if (completedWork(item)) accepted += 1;
        if (item.execution?.state === "uncertain") executionUncertain += 1;
      }
      cursor = next.id;
    }
  } catch (error) {
    // Out of traversal budget: report what was counted and where to continue.
    // Nothing counted means no progress is possible within this bound.
    if (
      !(error instanceof WorkQueueRefusal) ||
      error.failure.code !== "resource-exhausted" ||
      cursor === after
    )
      throw error;
  }
  const whole = complete && after === null;
  return {
    revision: queue.revision,
    total,
    dispositions,
    archived,
    accepted,
    executionUncertain,
    groups,
    state: !whole
      ? "partial"
      : total === 0
        ? "empty"
        : accepted === total
          ? "all-completed"
          : "in-progress",
    coverage: { complete, next: complete ? null : cursor },
  };
}

export type SelectionStatus =
  | "admissible"
  | "accepted"
  | "archived"
  | "cancelled"
  | "blocked"
  | "unavailable";

/**
 * Resolves selected groups and tasks to unique tasks at one revision, with a
 * reason for every task that will not be admitted. Deterministic, bounded and
 * complete, or refused: never a truncated manifest.
 */
export function expandWorkSelection(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  selection: { readonly groups: readonly WorkItemId[]; readonly tasks: readonly WorkItemId[] },
  budget: WorkValidation,
) {
  const tasks = new Map<WorkItemId, SelectionStatus>();
  const classify = (item: WorkItem): SelectionStatus =>
    item.deleted
      ? "unavailable"
      : completedWork(item)
        ? "accepted"
        : item.disposition === "cancelled"
          ? "cancelled"
          : item.disposition === "archived"
            ? "archived"
            : item.blockers.length > 0 || item.unresolvedDependencies || item.claim !== null
              ? "blocked"
              : "admissible";
  const collect = (group: WorkItemId, depth: number) => {
    if (depth > WORK_QUEUE_LIMITS.depth) refuseWork("corrupt");
    for (const child of liveChildren(tx, queue, group, budget)) {
      if (child.node.kind === "group") collect(child.id, depth + 1);
      else if (!tasks.has(child.id)) tasks.set(child.id, classify(child.node.item));
    }
  };
  for (const group of selection.groups) {
    liveGroup(tx, queue, group);
    collect(group, ancestorsOf(tx, queue, group, budget).length + 2);
  }
  for (const id of selection.tasks) {
    budget.step();
    if (tasks.has(id)) continue;
    const item = tx.item(queue.id, id);
    if (item === null)
      refuseWork(tx.group(queue.id, id) === null ? "unavailable" : "invalid-hierarchy");
    tasks.set(id, classify(item));
  }
  return {
    revision: queue.revision,
    groups: [...new Set(selection.groups)],
    tasks: [...tasks.entries()].map(([id, status]) => ({ id, status })),
  };
}

/** The next node after `from` in pre-order within `root`'s subtree (the whole queue for null). */
export function nextInSubtree(
  tx: WorkQueueTransaction,
  queue: WorkQueue,
  root: WorkItemId | null,
  from: WorkItemId | null,
  budget: WorkValidation,
): (WorkChild & { readonly node: WorkNode }) | null {
  if (from === null) return liveChildren(tx, queue, root, budget).next().value ?? null;
  const current = workNode(tx, queue, from);
  if (current === null || deleted(current)) refuseWork("stale-page");
  if (current.kind === "group") {
    const first = liveChildren(tx, queue, from, budget).next().value;
    if (first !== undefined) return first;
  }
  let id = from;
  for (;;) {
    budget.step();
    const placement = placementOf(tx, queue, id);
    // A cursor that climbs out of the requested subtree no longer belongs to it.
    if (placement.parent === null && root !== null) refuseWork("stale-page");
    const next = liveChildren(tx, queue, placement.parent, budget, {
      id,
      order: placement.order,
    }).next().value;
    if (next !== undefined) return next;
    if (placement.parent === root || placement.parent === null) return null;
    id = placement.parent;
  }
}
