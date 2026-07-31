import { describe, expect, test } from "bun:test";

import {
  createManualClock,
  deadlineAt,
  duration,
  instant,
  type ManualClock,
  type ScopeId,
  type ScopeKind,
  scopeId,
} from "../domain/index.ts";
import {
  createScopeTree,
  MAX_LIVE_SCOPES,
  MAX_RETAINED_SCOPE_EVENTS,
  MAX_RETAINED_TERMINAL_SCOPES,
  MAX_SCOPE_DEPTH,
  type ScopeTree,
} from "./scope-tree.ts";

function makeTree(): { clock: ManualClock; tree: ScopeTree } {
  const clock = createManualClock(instant(0));
  return { clock, tree: createScopeTree({ clock }) };
}

function derive(tree: ScopeTree, parent: ScopeId, id: string, kind: ScopeKind = "turn"): ScopeId {
  const derived = tree.derive(parent, { kind, scopeId: scopeId.from(id) });
  if (!derived.ok) {
    throw new Error(`derive failed: ${derived.error.code}`);
  }
  return derived.value.scopeId;
}

describe("scope hierarchy", () => {
  test("opens a root application scope", () => {
    const { tree } = makeTree();
    const root = tree.root();
    expect(root.kind).toBe("application");
    expect(root.parentId).toBeNull();
    expect(root.depth).toBe(0);
    expect(tree.state(root.scopeId)).toEqual({ status: "active" });
  });

  test("rejects deriving from an unknown scope", () => {
    const { tree } = makeTree();
    const derived = tree.derive(scopeId.from("nowhere"), { kind: "turn" });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("unknown-scope");
    }
  });

  test("rejects a duplicate scope identifier", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    derive(tree, root, "turn-1");
    const again = tree.derive(root, { kind: "turn", scopeId: scopeId.from("turn-1") });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("duplicate-scope");
    }
  });

  test("bounds nesting depth", () => {
    const { tree } = makeTree();
    let parent = tree.root().scopeId;
    for (let depth = 1; depth <= MAX_SCOPE_DEPTH - 1; depth += 1) {
      parent = derive(tree, parent, `depth-${depth}`, "child");
    }
    const tooDeep = tree.derive(parent, { kind: "child" });
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) {
      expect(tooDeep.error.code).toBe("scope-depth-exceeded");
    }
  });

  test("refuses to derive under a terminal parent", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const turn = derive(tree, root, "turn-1");
    tree.complete(turn);
    const derived = tree.derive(turn, { kind: "invocation" });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("scope-already-terminal");
    }
  });
});

describe("deadline inheritance", () => {
  test("a child cannot enlarge its parent's deadline", () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock, rootDeadline: deadlineAt(instant(1_000)) });
    const child = tree.derive(tree.root().scopeId, {
      kind: "turn",
      deadline: deadlineAt(instant(9_000)),
    });
    expect(child.ok).toBe(true);
    if (child.ok) {
      expect(child.value.deadline).toEqual(deadlineAt(instant(1_000)));
    }
  });

  test("a tighter request is honoured", () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock, rootDeadline: deadlineAt(instant(1_000)) });
    const child = tree.derive(tree.root().scopeId, {
      kind: "turn",
      deadline: deadlineAt(instant(400)),
    });
    expect(child.ok && child.value.deadline).toEqual(deadlineAt(instant(400)));
  });

  test("the tighter limit keeps applying down the chain", () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock, rootDeadline: deadlineAt(instant(1_000)) });
    const turn = tree.derive(tree.root().scopeId, {
      kind: "turn",
      deadline: deadlineAt(instant(600)),
    });
    if (!turn.ok) {
      throw new Error("derive failed");
    }
    const invocation = tree.derive(turn.value.scopeId, {
      kind: "invocation",
      deadline: deadlineAt(instant(5_000)),
    });
    expect(invocation.ok && invocation.value.deadline).toEqual(deadlineAt(instant(600)));
  });
});

describe("cancellation propagation", () => {
  test("reaches every descendant and aborts their signals", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const session = derive(tree, root, "session-1", "session");
    const turn = derive(tree, session, "turn-1");
    const invocation = derive(tree, turn, "invocation-1", "invocation");

    const cancelled = tree.cancel(session, { kind: "requested" });
    expect(cancelled.ok).toBe(true);

    for (const id of [session, turn, invocation]) {
      expect(tree.state(id)?.status).toBe("cancelling");
    }
    expect(tree.state(root)?.status).toBe("active");
  });

  test("does not disturb an already-terminal descendant", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const turn = derive(tree, root, "turn-1");
    const invocation = derive(tree, turn, "invocation-1", "invocation");
    tree.complete(invocation);

    tree.cancel(turn, { kind: "requested" });
    expect(tree.state(invocation)).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
  });

  test("names the origin scope on every descendant", () => {
    const { tree } = makeTree();
    const session = derive(tree, tree.root().scopeId, "session-1", "session");
    const turn = derive(tree, session, "turn-1");

    tree.cancel(session, { kind: "requested" });
    expect(tree.state(turn)).toMatchObject({
      status: "cancelling",
      reason: { kind: "parent-cancelled", originScopeId: session },
    });
  });

  test("a child derived under a cancelling parent starts cancelling too", () => {
    const { tree } = makeTree();
    const session = derive(tree, tree.root().scopeId, "session-1", "session");
    tree.cancel(session, { kind: "requested" });

    const late = derive(tree, session, "turn-late");
    expect(tree.state(late)?.status).toBe("cancelling");
  });

  test("cancelling twice does not re-request", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    const first = tree.cancel(turn, { kind: "requested" });
    const second = tree.cancel(turn, { kind: "shutdown" });
    expect(first.ok && first.value).toHaveLength(1);
    expect(second.ok && second.value).toEqual([]);
  });
});

describe("terminal semantics", () => {
  test("cancelling an observation is cancelled, and its evidence is kept", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    // Work an observation already finished before the cancellation arrived.
    const finished = derive(tree, turn, "read-1", "invocation");
    tree.recordEffect(finished, "completed");
    tree.complete(finished);

    tree.cancel(turn, { kind: "requested" });
    const acknowledged = tree.acknowledge(turn);

    expect(acknowledged).toEqual({ ok: true, value: { kind: "cancelled", effect: "none" } });
    expect(tree.report(turn)?.requiresInspection).toBe(false);

    // The evidence gathered before cancellation survives it unchanged.
    expect(tree.state(finished)).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
    expect(tree.report(finished)?.recordedEffect).toBe("completed");
    expect(tree.report(turn)?.subtreeEffect).toBe("completed");
  });

  test("acknowledgement latency is observable once a scope settles", async () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock });
    const turn = tree.derive(tree.root().scopeId, { kind: "turn" });
    if (!turn.ok) {
      throw new Error("derive failed");
    }

    expect(tree.report(turn.value.scopeId)?.cancellationLatency).toBeNull();

    await clock.advance(duration(40));
    tree.cancel(turn.value.scopeId, { kind: "requested" });
    expect(tree.report(turn.value.scopeId)?.cancellationLatency).toBeNull();

    await clock.advance(duration(120));
    tree.acknowledge(turn.value.scopeId);
    expect(tree.report(turn.value.scopeId)?.cancellationLatency).toBe(duration(120));
  });

  test("a scope that was never cancelled reports no latency", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.complete(turn);
    expect(tree.report(turn)?.cancellationLatency).toBeNull();
  });

  test("latency is measured from the first request, not a later one", async () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock });
    const turn = tree.derive(tree.root().scopeId, { kind: "turn" });
    if (!turn.ok) {
      throw new Error("derive failed");
    }

    tree.cancel(turn.value.scopeId, { kind: "requested" });
    await clock.advance(duration(50));
    tree.cancel(turn.value.scopeId, { kind: "shutdown" });
    await clock.advance(duration(50));
    tree.acknowledge(turn.value.scopeId);

    expect(tree.report(turn.value.scopeId)?.cancellationLatency).toBe(duration(100));
  });

  test("cancelling a mutation is uncertain, not cancelled", () => {
    const { tree } = makeTree();
    const invocation = derive(tree, tree.root().scopeId, "invocation-1", "invocation");
    tree.recordEffect(invocation, "partial");
    tree.cancel(invocation, { kind: "requested" });

    const acknowledged = tree.acknowledge(invocation);
    expect(acknowledged).toEqual({ ok: true, value: { kind: "uncertain", effect: "uncertain" } });
    expect(tree.report(invocation)?.requiresInspection).toBe(true);
  });

  test("a deadline cancellation acknowledges as timed-out", async () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock });
    const turn = tree.derive(tree.root().scopeId, {
      kind: "turn",
      deadline: deadlineAt(instant(100)),
    });
    if (!turn.ok) {
      throw new Error("derive failed");
    }

    await clock.advance(duration(100));
    const expired = tree.expireDeadlines(true);
    expect(expired).toHaveLength(1);
    expect(tree.state(turn.value.scopeId)).toMatchObject({
      status: "cancelling",
      reason: { kind: "deadline-exceeded", deadline: deadlineAt(instant(100)), escalated: true },
    });

    expect(tree.acknowledge(turn.value.scopeId)).toEqual({
      ok: true,
      value: { kind: "timed-out", effect: "none" },
    });
  });

  test("an unexpired deadline is left alone", () => {
    const clock = createManualClock(instant(0));
    const tree = createScopeTree({ clock });
    tree.derive(tree.root().scopeId, { kind: "turn", deadline: deadlineAt(instant(100)) });
    expect(tree.expireDeadlines()).toEqual([]);
  });

  test("completion does not erase a partial effect", () => {
    const { tree } = makeTree();
    const invocation = derive(tree, tree.root().scopeId, "invocation-1", "invocation");
    tree.recordEffect(invocation, "partial");

    expect(tree.complete(invocation)).toEqual({ ok: true, value: { kind: "completed" } });
    const report = tree.report(invocation);
    expect(report?.recordedEffect).toBe("partial");
    expect(report?.requiresInspection).toBe(true);
  });

  test("an effect never moves back toward certainty", () => {
    const { tree } = makeTree();
    const invocation = derive(tree, tree.root().scopeId, "invocation-1", "invocation");
    tree.recordEffect(invocation, "uncertain");
    tree.recordEffect(invocation, "none");
    expect(tree.report(invocation)?.recordedEffect).toBe("uncertain");
  });

  test("a parent's report surfaces a descendant's uncertainty", () => {
    const { tree } = makeTree();
    const session = derive(tree, tree.root().scopeId, "session-1", "session");
    const turn = derive(tree, session, "turn-1");
    tree.recordEffect(turn, "uncertain");

    const report = tree.report(session);
    expect(report?.recordedEffect).toBe("none");
    expect(report?.subtreeEffect).toBe("uncertain");
    expect(report?.requiresInspection).toBe(true);
  });

  test("a terminal scope cannot be settled twice or gain an effect", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.complete(turn);

    expect(tree.complete(turn).ok).toBe(false);
    expect(tree.acknowledge(turn).ok).toBe(false);
    const recorded = tree.recordEffect(turn, "partial");
    expect(recorded.ok).toBe(false);
    if (!recorded.ok) {
      expect(recorded.error.code).toBe("scope-already-terminal");
    }
  });

  test("failure carries the effect the scope had reached", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.recordEffect(turn, "partial");
    expect(tree.fail(turn)).toEqual({ ok: true, value: { kind: "failed", effect: "partial" } });
  });

  test("force settling leaves nothing non-terminal and claims no success", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.cancel(turn, { kind: "shutdown" });

    tree.forceSettleUnacknowledged();
    expect(tree.liveScopeCount()).toBe(0);
    expect(tree.state(turn)).toMatchObject({
      status: "terminal",
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
  });

  test("force settling does not rewrite a scope that already completed", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.complete(turn);
    tree.forceSettleUnacknowledged();
    expect(tree.state(turn)).toMatchObject({ outcome: { kind: "completed" } });
  });
});

describe("scope events", () => {
  test("are ordered and cover the whole lifecycle", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.recordEffect(turn, "partial");
    tree.cancel(turn, { kind: "requested" });
    tree.acknowledge(turn);

    const forTurn = tree.events().filter((event) => event.scopeId === turn);
    expect(forTurn.map((event) => event.kind)).toEqual([
      "scope.opened",
      "scope.effect.recorded",
      "scope.cancellation.requested",
      "scope.terminal",
    ]);
    expect(forTurn.map((event) => event.order)).toEqual(
      [...forTurn.map((e) => e.order)].sort((a, b) => a - b),
    );
  });

  test("order is monotonic across interleaved scopes", () => {
    const { tree } = makeTree();
    const first = derive(tree, tree.root().scopeId, "turn-1");
    const second = derive(tree, tree.root().scopeId, "turn-2");
    tree.complete(first);
    tree.complete(second);

    const orders = tree.events().map((event) => event.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("a parent's cancellation is observed before its children's", () => {
    const { tree } = makeTree();
    const session = derive(tree, tree.root().scopeId, "session-1", "session");
    const turn = derive(tree, session, "turn-1");
    const invocation = derive(tree, turn, "invocation-1", "invocation");

    const cancelled = tree.cancel(session, { kind: "requested" });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.map((event) => event.scopeId)).toEqual([session, turn, invocation]);
    }
  });

  test("a subscriber receives events until it unsubscribes", () => {
    const { tree } = makeTree();
    const seen: string[] = [];
    const release = tree.subscribe((event) => seen.push(event.kind));

    const turn = derive(tree, tree.root().scopeId, "turn-1");
    release();
    tree.complete(turn);

    expect(seen).toEqual(["scope.opened"]);
  });

  test("a terminal event carries the outcome and the recorded effect", () => {
    const { tree } = makeTree();
    const turn = derive(tree, tree.root().scopeId, "turn-1");
    tree.recordEffect(turn, "partial");
    tree.cancel(turn, { kind: "requested" });
    tree.acknowledge(turn);

    const terminal = tree.events().find((event) => event.kind === "scope.terminal");
    expect(terminal?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    expect(terminal?.effect).toBe("partial");
    expect(terminal?.reason).toEqual({ kind: "requested" });
  });
});

describe("resource bounds", () => {
  test("settled scopes do not consume the live budget", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;

    // Far past the live bound, but every scope finishes before the next starts.
    for (let index = 0; index < MAX_LIVE_SCOPES * 2; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error(`derive refused after ${index} settled scopes: ${turn.error.code}`);
      }
      tree.complete(turn.value.scopeId);
    }

    expect(tree.liveScopeCount()).toBe(1);
    expect(tree.derive(root, { kind: "turn" }).ok).toBe(true);
  });

  test("the live bound refuses only when scopes really are not settling", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;

    let derived = 0;
    for (;;) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        expect(turn.error).toEqual({
          code: "scope-count-exceeded",
          maximumScopes: MAX_LIVE_SCOPES,
        });
        break;
      }
      derived += 1;
    }

    // The root plus the derived scopes are all still live.
    expect(derived).toBe(MAX_LIVE_SCOPES - 1);
    expect(tree.liveScopeCount()).toBe(MAX_LIVE_SCOPES);
  });

  test("settling a scope frees budget for the next one", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const live: ScopeId[] = [];

    for (let index = 0; index < MAX_LIVE_SCOPES - 1; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error("derive failed early");
      }
      live.push(turn.value.scopeId);
    }
    expect(tree.derive(root, { kind: "turn" }).ok).toBe(false);

    const first = live[0];
    if (first === undefined) {
      throw new Error("no scope to settle");
    }
    tree.complete(first);
    expect(tree.derive(root, { kind: "turn" }).ok).toBe(true);
  });

  test("retained settled scopes are bounded", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;

    for (let index = 0; index < MAX_RETAINED_TERMINAL_SCOPES * 3; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error("derive failed");
      }
      tree.complete(turn.value.scopeId);
    }

    // The root stays, plus at most one retention window of settled scopes.
    expect(tree.retainedScopeCount()).toBeLessThanOrEqual(MAX_RETAINED_TERMINAL_SCOPES + 1);
    expect(tree.children(root).length).toBeLessThanOrEqual(MAX_RETAINED_TERMINAL_SCOPES);
  });

  test("an evicted scope's uncertainty stays visible from its parent", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;

    const mutation = tree.derive(root, { kind: "invocation" });
    if (!mutation.ok) {
      throw new Error("derive failed");
    }
    tree.recordEffect(mutation.value.scopeId, "uncertain");
    tree.complete(mutation.value.scopeId);

    // Push it out of the retention window.
    for (let index = 0; index < MAX_RETAINED_TERMINAL_SCOPES + 5; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error("derive failed");
      }
      tree.complete(turn.value.scopeId);
    }

    expect(tree.report(mutation.value.scopeId)).toBeNull();
    const rootReport = tree.report(root);
    expect(rootReport?.subtreeEffect).toBe("uncertain");
    expect(rootReport?.requiresInspection).toBe(true);
  });

  test("a generated identifier is never reissued after eviction", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const seen = new Set<string>();

    for (let index = 0; index < MAX_RETAINED_TERMINAL_SCOPES * 2; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error(`derive failed: ${turn.error.code}`);
      }
      expect(seen.has(turn.value.scopeId)).toBe(false);
      seen.add(turn.value.scopeId);
      tree.complete(turn.value.scopeId);
    }
  });

  test("the event log is bounded and reports what it dropped", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;

    for (let index = 0; index < MAX_RETAINED_SCOPE_EVENTS; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error("derive failed");
      }
      tree.complete(turn.value.scopeId);
    }

    expect(tree.events().length).toBeLessThanOrEqual(MAX_RETAINED_SCOPE_EVENTS);
    expect(tree.droppedEventCount()).toBeGreaterThan(0);
    // Order keeps counting past the drop, so a consumer can tell it missed some.
    expect(tree.events()[0]?.order).toBeGreaterThan(1);
  });

  test("a live scope is never evicted to make room", () => {
    const { tree } = makeTree();
    const root = tree.root().scopeId;
    const survivor = tree.derive(root, { kind: "session" });
    if (!survivor.ok) {
      throw new Error("derive failed");
    }

    for (let index = 0; index < MAX_RETAINED_TERMINAL_SCOPES * 2; index += 1) {
      const turn = tree.derive(root, { kind: "turn" });
      if (!turn.ok) {
        throw new Error("derive failed");
      }
      tree.complete(turn.value.scopeId);
    }

    expect(tree.state(survivor.value.scopeId)).toEqual({ status: "active" });
    expect(tree.liveScopeCount()).toBe(2);
  });
});
