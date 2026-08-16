/**
 * The runtime's cancellation scope tree.
 *
 * One tree owns every scope in the process. Cancellation is applied
 * breadth-first from the cancelled scope downward, so a parent's request is
 * always observed before its children's, and the resulting event order is the
 * order a surface can render without reordering.
 *
 * Two invariants are enforced here rather than left to callers:
 *
 * - a scope's deadline is the tighter of its parent's and its own request, so
 *   deriving a child can only ever narrow what it inherited; and
 * - a scope's recorded effect only moves toward more uncertainty, so settling a
 *   scope cannot erase a partial mutation it already reported.
 */

import {
  type CancellationReason,
  type ClockPort,
  cancellationOutcomeFor,
  type Deadline,
  deriveDeadline,
  type EffectCertainty,
  elapsedBetween,
  err,
  type Instant,
  isExpired,
  NO_CORRELATION,
  ok,
  type Result,
  type ScopeError,
  type ScopeEvent,
  type ScopeId,
  type ScopeKind,
  type ScopeReport,
  type ScopeState,
  scopeId as scopeIdCodec,
  type TerminalOutcome,
  timeoutOutcomeFor,
  worstEffect,
} from "../domain/index.ts";
import type { DiagnosticsCollector } from "./diagnostics-collector.ts";

/** Depth of the application → session → turn → attempt → invocation → child chain. */
export const MAX_SCOPE_DEPTH = 16;

/**
 * Scopes that may be live — not yet terminal — at one time.
 *
 * This counts live scopes only. Settled scopes do not consume the budget: a
 * session that completes ten thousand turns has done nothing wrong, and
 * refusing its next turn would be a false report of runaway work.
 */
export const MAX_LIVE_SCOPES = 10_000;

/**
 * Settled scopes kept for inspection after they finish.
 *
 * A caller needs to read the outcome of work that just ended, so a terminal
 * scope is retained rather than dropped immediately. Beyond this window the
 * oldest are evicted; their effect has already been folded into their parent,
 * so evicting one never loses the fact that something uncertain happened.
 */
export const MAX_RETAINED_TERMINAL_SCOPES = 1_000;

/**
 * Ancestor-chain tombstones kept after a settled scope is evicted.
 *
 * Eviction refuses a node with retained children, not a node with live scheduled
 * units, so a scope can leave the tree while work still bound to it is stopping.
 * The tombstone is only that scope's id and the ancestor ids captured at
 * eviction — enough for a late effect to fold upward, not enough to restore the
 * node. The cap matches the retained-terminal window: a late effect that arrives
 * after this many further evictions is unattributable again.
 */
export const MAX_EVICTED_TOMBSTONES = MAX_RETAINED_TERMINAL_SCOPES;

/** Lifecycle events retained for diagnostics. Older ones are dropped and counted. */
export const MAX_RETAINED_SCOPE_EVENTS = 10_000;

/** Events discarded per trim, so trimming is amortized rather than per-event. */
const SCOPE_EVENT_TRIM_CHUNK = 1_024;

export type ScopeHandle = {
  readonly scopeId: ScopeId;
  readonly kind: ScopeKind;
  readonly parentId: ScopeId | null;
  readonly deadline: Deadline | null;
  /** Aborts when this scope, or any ancestor, begins cancelling. */
  readonly signal: AbortSignal;
  /** Distance from the root. The root is zero. */
  readonly depth: number;
};

export type DeriveScopeOptions = {
  readonly kind: ScopeKind;
  /** Capped by the parent's deadline. A looser request is narrowed, not rejected. */
  readonly deadline?: Deadline | null;
  /** Supplied by the caller so a scope can be correlated with work it already named. */
  readonly scopeId?: ScopeId;
};

/**
 * What recording an effect that may have arrived late did to the tree.
 *
 * Returned instead of `void` so a caller can tell an ordinary record from one
 * that missed its scope, and report the difference rather than discarding it.
 */
export type LateEffectRecord = {
  readonly scopeId: ScopeId;
  readonly effect: EffectCertainty;
  /**
   * Whether the scope had already settled when the effect arrived.
   *
   * `false` is the ordinary case: the scope was still live and recorded the
   * effect itself.
   */
  readonly late: boolean;
  /**
   * Ancestors that absorbed a late effect, nearest first.
   *
   * Empty when the scope was still live — it recorded the effect itself — or
   * when a settled root had no ancestor left to carry it. An empty list on a
   * late record means the effect is real but unattributable.
   */
  readonly foldedInto: readonly ScopeId[];
};

export type ScopeTree = {
  root(): ScopeHandle;
  derive(parentId: ScopeId, options: DeriveScopeOptions): Result<ScopeHandle, ScopeError>;

  /**
   * Requests cancellation of a scope and every descendant.
   *
   * Returns the ordered events it produced. Scopes move to `cancelling`, not to
   * a terminal state: the work still has to acknowledge, and pretending
   * otherwise is exactly the "reported completion before cleanup" failure.
   */
  cancel(scopeId: ScopeId, reason: CancellationReason): Result<readonly ScopeEvent[], ScopeError>;

  /**
   * Records what a scope has done to the world.
   *
   * Monotonic toward uncertainty. Recording `none` over a `partial` is accepted
   * and ignored rather than rejected, because a caller reporting progress
   * should not have to know what was recorded before it.
   */
  recordEffect(scopeId: ScopeId, effect: EffectCertainty): Result<void, ScopeError>;

  /**
   * Records an effect from work that may have outlived its scope.
   *
   * `complete()` accepts a scope with live work still under it, and stopping is
   * cooperative — work is asked to stop and settles when it chooses to. So a
   * scope can settle first and its work report an effect afterwards, and
   * `recordEffect` refuses that with `scope-already-terminal`. Refusing is
   * right: a terminal outcome that could still change is not terminal, and
   * rewriting one would erase the fact a caller already read.
   *
   * The effect is real regardless, so it is folded into every surviving
   * ancestor's settled-descendant effect instead — the same upward fold a scope
   * performs when it settles normally. The settled scope's own frozen outcome
   * is left alone; its ancestors are what still have to report that something
   * uncertain happened underneath them.
   *
   * A scope that is still live simply records the effect, so a caller racing
   * the settle does not have to check the state first.
   *
   * `unknown-scope` means the scope is gone and its eviction tombstone has also
   * been trimmed. Nothing is left to attribute it to; only the caller's
   * diagnostic records it. A still-held tombstone folds the effect into every
   * surviving ancestor without restoring the evicted node.
   */
  recordLateEffect(scopeId: ScopeId, effect: EffectCertainty): Result<LateEffectRecord, ScopeError>;

  /**
   * Settles a scope that finished on its own.
   *
   * The recorded effect is preserved, so a scope that mutated something and
   * then completed still reports the mutation.
   */
  complete(scopeId: ScopeId): Result<TerminalOutcome, ScopeError>;

  /** Settles a scope that failed on its own. */
  fail(scopeId: ScopeId): Result<TerminalOutcome, ScopeError>;

  /**
   * Acknowledges that a cancelling scope has stopped.
   *
   * This is the terminal acknowledgement a surface waits for. The outcome
   * follows the scope's recorded effect, not the cancellation request.
   */
  acknowledge(scopeId: ScopeId): Result<TerminalOutcome, ScopeError>;

  /**
   * Cancels every scope whose deadline has passed, according to the clock.
   *
   * Expiry is polled rather than timer-driven so the tree stays a pure function
   * of the clock; the coordinator that owns waiting decides when to poll.
   */
  expireDeadlines(escalated?: boolean): readonly ScopeEvent[];

  /**
   * Settles every scope still cancelling, without waiting for acknowledgement.
   *
   * Used only under force. Anything unacknowledged becomes `uncertain`: the
   * work was not observed stopping, and force must not upgrade that to success.
   */
  forceSettleUnacknowledged(): readonly ScopeEvent[];

  /**
   * The handle for an existing scope.
   *
   * The scheduler needs a scope's abort signal to bind work to it, and it is
   * handed a `WorkUnit.scopeId` rather than the handle that created the scope.
   */
  handle(scopeId: ScopeId): ScopeHandle | null;
  report(scopeId: ScopeId): ScopeReport | null;
  /** Scopes held in memory: live ones plus settled ones still inside the retention window. */
  retainedScopeCount(): number;
  /** Lifecycle events discarded from the retained log, so truncation stays visible. */
  droppedEventCount(): number;
  state(scopeId: ScopeId): ScopeState | null;
  children(scopeId: ScopeId): readonly ScopeId[];
  /** Scopes not yet terminal. This is what the live-scope bound measures. */
  liveScopeCount(): number;
  /** Every event so far, in order. */
  events(): readonly ScopeEvent[];
  subscribe(listener: (event: ScopeEvent) => void): () => void;
};

type ScopeNode = {
  readonly scopeId: ScopeId;
  readonly kind: ScopeKind;
  readonly parentId: ScopeId | null;
  readonly depth: number;
  readonly deadline: Deadline | null;
  readonly controller: AbortController;
  readonly children: ScopeId[];
  state: ScopeState;
  effect: EffectCertainty;
  /**
   * The worst effect any already-settled descendant reported.
   *
   * Folded in when a child settles, so a parent keeps surfacing a descendant's
   * uncertainty after that descendant has been evicted.
   */
  settledDescendantEffect: EffectCertainty;
  /** When cancellation was first requested, so acknowledgement latency is observable. */
  cancellationRequestedAt: Instant | null;
  /**
   * Ordinal for the next generated child identifier.
   *
   * Monotonic, and deliberately not derived from `children.length`: children are
   * evicted once settled, so a length-based name would be reissued and collide
   * with a scope still retained.
   */
  nextChildOrdinal: number;
};

export type ScopeTreeOptions = {
  readonly clock: ClockPort;
  /**
   * Where lifecycle diagnostics go.
   *
   * Injected rather than constructed here: one collector serves the whole
   * runtime, and a tree that made its own would report into a buffer nobody
   * reads.
   */
  readonly diagnostics?: DiagnosticsCollector;
  readonly rootScopeId?: ScopeId;
  readonly rootDeadline?: Deadline | null;
};

export function createScopeTree(options: ScopeTreeOptions): ScopeTree {
  const { clock, diagnostics } = options;
  const nodes = new Map<ScopeId, ScopeNode>();
  const events: ScopeEvent[] = [];
  /** Settled scopes still retained, oldest first. */
  const retained: ScopeId[] = [];
  /** Evicted scopes still attributable, oldest first. */
  const tombstones = new Map<ScopeId, readonly ScopeId[]>();
  const tombstoneOrder: ScopeId[] = [];
  let listeners: ((event: ScopeEvent) => void)[] = [];
  let order = 0;
  let liveCount = 0;
  let droppedEvents = 0;

  /**
   * Mirrors a lifecycle event into diagnostics.
   *
   * Carries identity, ordering, and — on a terminal event — how long the scope
   * took to acknowledge. No payload: a scope event has none, and the diagnostic
   * shape would not accept one anyway.
   */
  const emitDiagnostic = (event: ScopeEvent, node: ScopeNode): void => {
    if (diagnostics === undefined) {
      return;
    }
    const latency =
      event.kind === "scope.terminal" && node.cancellationRequestedAt !== null
        ? elapsedBetween(node.cancellationRequestedAt, event.at)
        : null;

    diagnostics.emit({
      level: event.kind === "scope.terminal" ? "info" : "debug",
      subsystem: "scope",
      code: event.kind,
      correlation: { ...NO_CORRELATION, scopeId: event.scopeId },
      stage: event.scopeKind,
      durationMs: latency,
      metadata: {
        order: event.order,
        ...(event.outcome === null ? {} : { outcome: event.outcome.kind }),
        ...(event.effect === null ? {} : { effect: event.effect }),
        ...(event.reason === null ? {} : { reason: event.reason.kind }),
      },
    });
  };

  const emit = (
    kind: ScopeEvent["kind"],
    node: ScopeNode,
    at: Instant,
    detail: {
      reason?: CancellationReason | null;
      outcome?: TerminalOutcome | null;
      effect?: EffectCertainty | null;
    } = {},
  ): ScopeEvent => {
    order += 1;
    const event: ScopeEvent = {
      order,
      kind,
      scopeId: node.scopeId,
      scopeKind: node.kind,
      at,
      reason: detail.reason ?? null,
      outcome: detail.outcome ?? null,
      effect: detail.effect ?? null,
    };
    events.push(event);
    if (events.length > MAX_RETAINED_SCOPE_EVENTS) {
      droppedEvents += events.splice(0, SCOPE_EVENT_TRIM_CHUNK).length;
    }
    emitDiagnostic(event, node);
    for (const listener of [...listeners]) {
      listener(event);
    }
    return event;
  };

  const rootId = options.rootScopeId ?? scopeIdCodec.from("scope-root");
  const rootNode: ScopeNode = {
    scopeId: rootId,
    kind: "application",
    parentId: null,
    depth: 0,
    deadline: options.rootDeadline ?? null,
    controller: new AbortController(),
    children: [],
    state: { status: "active" },
    effect: "none",
    settledDescendantEffect: "none",
    cancellationRequestedAt: null,
    nextChildOrdinal: 1,
  };
  nodes.set(rootId, rootNode);
  liveCount += 1;
  emit("scope.opened", rootNode, clock.now());

  const handleOf = (node: ScopeNode): ScopeHandle => ({
    scopeId: node.scopeId,
    kind: node.kind,
    parentId: node.parentId,
    deadline: node.deadline,
    signal: node.controller.signal,
    depth: node.depth,
  });

  const descendantsOf = (start: ScopeNode): ScopeNode[] => {
    const collected: ScopeNode[] = [];
    const queue: ScopeId[] = [...start.children];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) {
        break;
      }
      const node = nodes.get(next);
      if (node === undefined) {
        continue;
      }
      collected.push(node);
      queue.push(...node.children);
    }
    return collected;
  };

  const totalEffectOf = (node: ScopeNode): EffectCertainty =>
    worstEffect(node.effect, node.settledDescendantEffect);

  const subtreeEffectOf = (node: ScopeNode): EffectCertainty =>
    descendantsOf(node).reduce<EffectCertainty>(
      (worst, descendant) => worstEffect(worst, totalEffectOf(descendant)),
      totalEffectOf(node),
    );

  const beginCancelling = (
    node: ScopeNode,
    reason: CancellationReason,
    at: Instant,
    collected: ScopeEvent[],
  ): void => {
    if (node.state.status !== "active") {
      return;
    }
    node.state = { status: "cancelling", reason, requestedAt: at };
    node.cancellationRequestedAt = at;
    node.controller.abort();
    collected.push(emit("scope.cancellation.requested", node, at, { reason }));
  };

  /**
   * Removes a settled scope from the tree.
   *
   * A scope is only evictable once nothing under it is still retained, so
   * eviction never orphans a live child or a descendant a caller can still read.
   * Scheduled units are not children; a still-stopping unit does not block
   * eviction. The ancestor chain is captured first so a later effect can still
   * fold upward through a tombstone.
   */
  const evict = (node: ScopeNode): boolean => {
    if (node.children.some((child) => nodes.has(child))) {
      return false;
    }
    const ancestorIds = ancestorIdsOf(node);
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent !== undefined) {
      const index = parent.children.indexOf(node.scopeId);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
    }
    nodes.delete(node.scopeId);
    rememberTombstone(node.scopeId, ancestorIds);
    return true;
  };

  const forgetTombstone = (scopeId: ScopeId): void => {
    if (!tombstones.delete(scopeId)) {
      return;
    }
    const index = tombstoneOrder.indexOf(scopeId);
    if (index >= 0) {
      tombstoneOrder.splice(index, 1);
    }
  };

  const rememberTombstone = (scopeId: ScopeId, ancestorIds: readonly ScopeId[]): void => {
    forgetTombstone(scopeId);
    tombstones.set(scopeId, ancestorIds);
    tombstoneOrder.push(scopeId);
    while (tombstoneOrder.length > MAX_EVICTED_TOMBSTONES) {
      const oldest = tombstoneOrder.shift();
      if (oldest !== undefined) {
        tombstones.delete(oldest);
      }
    }
  };

  const trimRetained = (): void => {
    let index = 0;
    while (retained.length - index > MAX_RETAINED_TERMINAL_SCOPES && index < retained.length) {
      const candidateId = retained[index];
      const candidate = candidateId === undefined ? undefined : nodes.get(candidateId);
      if (candidate === undefined || evict(candidate)) {
        retained.splice(index, 1);
        continue;
      }
      // Still has retained descendants. Leave it and try the next oldest; it
      // becomes evictable once they are gone.
      index += 1;
    }
  };

  /**
   * Folds an effect into every surviving ancestor, nearest first.
   *
   * Every ancestor, not just the parent: a parent may settle before its child,
   * in which case the parent's own fold upward already happened and nothing
   * would re-propagate the child's effect past it. While both remain in the
   * retention window `subtreeEffectOf` still walks them and hides the gap; once
   * both are evicted the ancestor reports `none` for work nobody observed
   * finishing — unless a tombstone still names that ancestor.
   *
   * `worstEffect` is an idempotent maximum, so reaching an ancestor that the
   * bottom-up ordering would have reached transitively costs nothing. The walk
   * is bounded by `MAX_SCOPE_DEPTH`, because `derive` refuses to nest deeper.
   *
   * This folds *effect reporting* upward. Cancellation still propagates
   * downward only; the two travel in opposite directions by design.
   */
  const ancestorIdsOf = (node: ScopeNode): ScopeId[] => {
    const ids: ScopeId[] = [];
    let ancestor = node.parentId === null ? undefined : nodes.get(node.parentId);
    while (ancestor !== undefined) {
      ids.push(ancestor.scopeId);
      ancestor = ancestor.parentId === null ? undefined : nodes.get(ancestor.parentId);
    }
    return ids;
  };

  const foldIntoAncestorIds = (
    ancestorIds: readonly ScopeId[],
    effect: EffectCertainty,
  ): ScopeId[] => {
    const reached: ScopeId[] = [];
    for (const ancestorId of ancestorIds) {
      const ancestor = nodes.get(ancestorId);
      if (ancestor === undefined) {
        continue;
      }
      ancestor.settledDescendantEffect = worstEffect(ancestor.settledDescendantEffect, effect);
      reached.push(ancestor.scopeId);
    }
    return reached;
  };

  const foldIntoAncestors = (node: ScopeNode, effect: EffectCertainty): ScopeId[] =>
    foldIntoAncestorIds(ancestorIdsOf(node), effect);

  const settle = (node: ScopeNode, outcome: TerminalOutcome, at: Instant): ScopeEvent => {
    const reason = node.state.status === "cancelling" ? node.state.reason : null;
    node.state = { status: "terminal", outcome, reason, settledAt: at };
    liveCount -= 1;

    // Fold before this scope can be evicted, so an evicted uncertainty is still
    // visible from above. `evict` refuses a node with a live child, so the
    // ancestor chain is always intact here.
    foldIntoAncestors(node, totalEffectOf(node));

    const event = emit("scope.terminal", node, at, { outcome, reason, effect: node.effect });
    retained.push(node.scopeId);
    trimRetained();
    return event;
  };

  const requireNode = (id: ScopeId): Result<ScopeNode, ScopeError> => {
    const node = nodes.get(id);
    return node === undefined ? err({ code: "unknown-scope", scopeId: id }) : ok(node);
  };

  /** Raises a live scope's own effect, emitting only when it actually moved. */
  const applyEffect = (node: ScopeNode, effect: EffectCertainty): void => {
    const updated = worstEffect(node.effect, effect);
    if (updated !== node.effect) {
      node.effect = updated;
      emit("scope.effect.recorded", node, clock.now(), { effect: updated });
    }
  };

  const settleSelf = (
    id: ScopeId,
    outcome: TerminalOutcome,
  ): Result<TerminalOutcome, ScopeError> => {
    const found = requireNode(id);
    if (!found.ok) {
      return found;
    }
    const node = found.value;
    if (node.state.status === "terminal") {
      return err({ code: "scope-already-terminal", scopeId: id });
    }
    settle(node, outcome, clock.now());
    return ok(outcome);
  };

  return {
    root(): ScopeHandle {
      return handleOf(rootNode);
    },

    derive(parentId: ScopeId, deriveOptions: DeriveScopeOptions): Result<ScopeHandle, ScopeError> {
      const found = requireNode(parentId);
      if (!found.ok) {
        return found;
      }
      const parent = found.value;
      if (parent.state.status === "terminal") {
        return err({ code: "scope-already-terminal", scopeId: parentId });
      }
      if (parent.depth + 1 >= MAX_SCOPE_DEPTH) {
        return err({ code: "scope-depth-exceeded", maximumDepth: MAX_SCOPE_DEPTH });
      }
      if (liveCount >= MAX_LIVE_SCOPES) {
        return err({ code: "scope-count-exceeded", maximumScopes: MAX_LIVE_SCOPES });
      }

      const childId =
        deriveOptions.scopeId ?? scopeIdCodec.from(`${parentId}.${parent.nextChildOrdinal}`);
      if (nodes.has(childId)) {
        return err({ code: "duplicate-scope", scopeId: childId });
      }
      forgetTombstone(childId);

      const controller = new AbortController();
      const node: ScopeNode = {
        scopeId: childId,
        kind: deriveOptions.kind,
        parentId,
        depth: parent.depth + 1,
        deadline: deriveDeadline(parent.deadline, deriveOptions.deadline ?? null),
        controller,
        children: [],
        state: { status: "active" },
        effect: "none",
        settledDescendantEffect: "none",
        cancellationRequestedAt: null,
        nextChildOrdinal: 1,
      };
      nodes.set(childId, node);
      liveCount += 1;
      parent.nextChildOrdinal += 1;
      parent.children.push(childId);
      emit("scope.opened", node, clock.now());

      // A child derived under an already-cancelling parent starts cancelling
      // too. Anything else would let a late child escape its parent's stop.
      if (parent.state.status === "cancelling") {
        const collected: ScopeEvent[] = [];
        beginCancelling(
          node,
          { kind: "parent-cancelled", originScopeId: parentId },
          clock.now(),
          collected,
        );
      }
      return ok(handleOf(node));
    },

    cancel(
      targetId: ScopeId,
      reason: CancellationReason,
    ): Result<readonly ScopeEvent[], ScopeError> {
      const found = requireNode(targetId);
      if (!found.ok) {
        return found;
      }
      const target = found.value;
      const at = clock.now();
      const collected: ScopeEvent[] = [];

      beginCancelling(target, reason, at, collected);
      for (const descendant of descendantsOf(target)) {
        beginCancelling(
          descendant,
          { kind: "parent-cancelled", originScopeId: targetId },
          at,
          collected,
        );
      }
      return ok(collected);
    },

    recordEffect(id: ScopeId, effect: EffectCertainty): Result<void, ScopeError> {
      const found = requireNode(id);
      if (!found.ok) {
        return found;
      }
      const node = found.value;
      if (node.state.status === "terminal") {
        return err({ code: "scope-already-terminal", scopeId: id });
      }
      applyEffect(node, effect);
      return ok(undefined);
    },

    recordLateEffect(id: ScopeId, effect: EffectCertainty): Result<LateEffectRecord, ScopeError> {
      const node = nodes.get(id);
      if (node !== undefined) {
        if (node.state.status !== "terminal") {
          applyEffect(node, effect);
          return ok({ scopeId: id, effect, late: false, foldedInto: [] });
        }
        // The scope's own frozen effect and outcome stay as they settled. Only
        // the ancestors, which are still accountable for what happened beneath
        // them, take the update.
        return ok({
          scopeId: id,
          effect,
          late: true,
          foldedInto: foldIntoAncestors(node, effect),
        });
      }
      const ancestorIds = tombstones.get(id);
      if (ancestorIds === undefined) {
        return err({ code: "unknown-scope", scopeId: id });
      }
      return ok({
        scopeId: id,
        effect,
        late: true,
        foldedInto: foldIntoAncestorIds(ancestorIds, effect),
      });
    },

    complete(id: ScopeId): Result<TerminalOutcome, ScopeError> {
      return settleSelf(id, { kind: "completed" });
    },

    fail(id: ScopeId): Result<TerminalOutcome, ScopeError> {
      const found = requireNode(id);
      if (!found.ok) {
        return found;
      }
      return settleSelf(id, { kind: "failed", effect: found.value.effect });
    },

    acknowledge(id: ScopeId): Result<TerminalOutcome, ScopeError> {
      const found = requireNode(id);
      if (!found.ok) {
        return found;
      }
      const node = found.value;
      if (node.state.status === "terminal") {
        return err({ code: "scope-already-terminal", scopeId: id });
      }
      const reason = node.state.status === "cancelling" ? node.state.reason : null;
      const outcome =
        reason?.kind === "deadline-exceeded"
          ? timeoutOutcomeFor(node.effect)
          : cancellationOutcomeFor(node.effect);
      settle(node, outcome, clock.now());
      return ok(outcome);
    },

    expireDeadlines(escalated = false): readonly ScopeEvent[] {
      const at = clock.now();
      const collected: ScopeEvent[] = [];
      for (const node of [...nodes.values()]) {
        if (node.state.status !== "active" || node.deadline === null) {
          continue;
        }
        if (!isExpired(node.deadline, clock)) {
          continue;
        }
        const reason: CancellationReason = {
          kind: "deadline-exceeded",
          deadline: node.deadline,
          escalated,
        };
        beginCancelling(node, reason, at, collected);
        for (const descendant of descendantsOf(node)) {
          beginCancelling(
            descendant,
            { kind: "parent-cancelled", originScopeId: node.scopeId },
            at,
            collected,
          );
        }
      }
      return collected;
    },

    forceSettleUnacknowledged(): readonly ScopeEvent[] {
      const at = clock.now();
      const collected: ScopeEvent[] = [];
      for (const node of [...nodes.values()]) {
        if (node.state.status === "terminal") {
          continue;
        }
        collected.push(settle(node, { kind: "uncertain", effect: "uncertain" }, at));
      }
      return collected;
    },

    handle(id: ScopeId): ScopeHandle | null {
      const node = nodes.get(id);
      return node === undefined ? null : handleOf(node);
    },

    report(id: ScopeId): ScopeReport | null {
      const node = nodes.get(id);
      if (node === undefined) {
        return null;
      }
      const subtreeEffect = subtreeEffectOf(node);
      return {
        scopeId: node.scopeId,
        kind: node.kind,
        parentId: node.parentId,
        state: node.state,
        deadline: node.deadline,
        recordedEffect: node.effect,
        subtreeEffect,
        requiresInspection: subtreeEffect === "partial" || subtreeEffect === "uncertain",
        cancellationLatency:
          node.cancellationRequestedAt === null || node.state.status !== "terminal"
            ? null
            : elapsedBetween(node.cancellationRequestedAt, node.state.settledAt),
      };
    },

    state(id: ScopeId): ScopeState | null {
      return nodes.get(id)?.state ?? null;
    },

    children(id: ScopeId): readonly ScopeId[] {
      return [...(nodes.get(id)?.children ?? [])];
    },

    liveScopeCount(): number {
      return liveCount;
    },

    retainedScopeCount(): number {
      return nodes.size;
    },

    events(): readonly ScopeEvent[] {
      return [...events];
    },

    droppedEventCount(): number {
      return droppedEvents;
    },

    subscribe(listener: (event: ScopeEvent) => void): () => void {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
  };
}
