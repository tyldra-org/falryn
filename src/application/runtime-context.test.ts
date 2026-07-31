import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createManualClock,
  deadlineAt,
  instant,
  scopeId,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import {
  contextFromScope,
  deriveContext,
  effectiveChildDeadline,
  toTurnContext,
} from "./runtime-context.ts";
import { createScopeTree } from "./scope-tree.ts";

function makeRoot(deadline = deadlineAt(instant(1_000))) {
  const clock = createManualClock(instant(0));
  const tree = createScopeTree({ clock, rootDeadline: deadline });
  const context = contextFromScope(tree.root(), configurationGeneration.from(3));
  return { clock, tree, context };
}

describe("runtime contexts", () => {
  test("carry scope, generation, cancellation, and deadline", () => {
    const { tree, context } = makeRoot();
    expect(context.scopeId).toBe(tree.root().scopeId);
    expect(context.configurationGeneration).toBe(configurationGeneration.from(3));
    expect(context.deadline).toEqual(deadlineAt(instant(1_000)));
    expect(context.cancellation.aborted).toBe(false);
  });

  test("a derived context cannot enlarge the inherited deadline", () => {
    const { tree, context } = makeRoot();
    const derived = deriveContext(tree, context, {
      kind: "turn",
      deadline: deadlineAt(instant(9_000)),
    });
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.value.context.deadline).toEqual(deadlineAt(instant(1_000)));
      expect(derived.value.deadlineCapped).toBe(true);
    }
  });

  test("a tighter derived deadline is honoured and not reported as capped", () => {
    const { tree, context } = makeRoot();
    const derived = deriveContext(tree, context, {
      kind: "turn",
      deadline: deadlineAt(instant(250)),
    });
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.value.context.deadline).toEqual(deadlineAt(instant(250)));
      expect(derived.value.deadlineCapped).toBe(false);
    }
  });

  test("a child keeps the generation its parent started under", () => {
    const { tree, context } = makeRoot();
    const derived = deriveContext(tree, context, { kind: "turn" });
    expect(derived.ok && derived.value.context.configurationGeneration).toBe(
      configurationGeneration.from(3),
    );
  });

  test("deriving is immutable — the parent is unchanged", () => {
    const { tree, context } = makeRoot();
    const before = { ...context };
    deriveContext(tree, context, { kind: "turn", deadline: deadlineAt(instant(10)) });
    expect(context).toEqual(before);
  });

  test("a derived context aborts when its ancestor cancels", () => {
    const { tree, context } = makeRoot();
    const derived = deriveContext(tree, context, { kind: "turn" });
    if (!derived.ok) {
      throw new Error("derive failed");
    }
    expect(derived.value.context.cancellation.aborted).toBe(false);

    tree.cancel(context.scopeId, { kind: "requested" });
    expect(derived.value.context.cancellation.aborted).toBe(true);
  });

  test("a named scope identifier is preserved", () => {
    const { tree, context } = makeRoot();
    const derived = deriveContext(tree, context, {
      kind: "invocation",
      scopeId: scopeId.from("invocation-42"),
    });
    expect(derived.ok && derived.value.context.scopeId).toBe(scopeId.from("invocation-42"));
  });

  test("propagates a scope failure instead of inventing a context", () => {
    const { tree, context } = makeRoot();
    const orphan = { ...context, scopeId: scopeId.from("missing") };
    const derived = deriveContext(tree, orphan, { kind: "turn" });
    expect(derived.ok).toBe(false);
    if (!derived.ok) {
      expect(derived.error.code).toBe("unknown-scope");
    }
  });

  test("reports the effective child deadline without creating a scope", () => {
    const { tree, context } = makeRoot();
    const before = tree.children(context.scopeId).length;
    expect(effectiveChildDeadline(context, deadlineAt(instant(9_000)))).toEqual(
      deadlineAt(instant(1_000)),
    );
    expect(tree.children(context.scopeId)).toHaveLength(before);
  });
});

describe("turn contexts", () => {
  test("add turn identity without losing runtime identity", () => {
    const { context } = makeRoot();
    const turn = toTurnContext(context, {
      workspaceId: workspaceId.from("workspace-1"),
      sessionId: sessionId.from("session-1"),
      turnId: turnId.from("turn-1"),
      traceId: traceId.from("trace-1"),
    });

    expect(turn.scopeId).toBe(context.scopeId);
    expect(turn.deadline).toEqual(context.deadline);
    expect(turn.turnId).toBe(turnId.from("turn-1"));
  });
});
