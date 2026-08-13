import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createToolHookRegistry,
  failurePostureForHookPoint,
  invocationId,
  isRecursionDenied,
  MAX_TOOL_HOOKS_PER_POINT,
  orderToolHooks,
  phaseForHookPoint,
  type RegisteredToolHook,
  settlePostHookDecisions,
  settlePreHookDecisions,
} from "./index.ts";

const generation = configurationGeneration.from(0);

function hook(
  id: string,
  point: RegisteredToolHook["point"],
  priority: number,
): RegisteredToolHook {
  return {
    id,
    point,
    priority,
    run: () => ({ kind: "allow" }),
  };
}

describe("tool hook registry", () => {
  test("orders by priority then stable id", () => {
    const ordered = orderToolHooks([
      hook("b.hook", "before-capability-invocation", 1),
      hook("a.hook", "before-capability-invocation", 1),
      hook("high", "before-capability-invocation", 10),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["high", "a.hook", "b.hook"]);
  });

  test("refuses duplicate ids and over-capacity points", () => {
    const duplicate = createToolHookRegistry(generation, [
      hook("same", "before-capability-invocation", 1),
      hook("same", "after-capability-invocation", 1),
    ]);
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) {
      throw new Error("expected duplicate");
    }
    expect(duplicate.error.code).toBe("duplicate-hook");

    const tooMany = createToolHookRegistry(
      generation,
      Array.from({ length: MAX_TOOL_HOOKS_PER_POINT + 1 }, (_, index) =>
        hook(`h${index}`, "before-capability-invocation", 0),
      ),
    );
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) {
      throw new Error("expected capacity");
    }
    expect(tooMany.error.code).toBe("too-many-hooks");
  });

  test("owns fail-closed pre and fail-open post postures", () => {
    expect(phaseForHookPoint("before-capability-invocation")).toBe("pre");
    expect(failurePostureForHookPoint("before-capability-invocation")).toBe("fail-closed");
    expect(phaseForHookPoint("after-capability-invocation")).toBe("post");
    expect(failurePostureForHookPoint("after-capability-invocation")).toBe("fail-open");
  });
});

describe("pre-hook settlement", () => {
  test("deny blocks later allows", () => {
    const settled = settlePreHookDecisions([
      { hookId: "deny.me", decision: { kind: "deny", reason: "blocked" } },
      { hookId: "later", decision: { kind: "allow" } },
    ]);
    expect(settled).toEqual({
      kind: "denied",
      reason: "blocked",
      hookId: "deny.me",
    });
  });

  test("conflicting annotation transforms fail visibly", () => {
    const settled = settlePreHookDecisions([
      { hookId: "one", decision: { kind: "transform", annotations: { note: "a" } } },
      { hookId: "two", decision: { kind: "transform", annotations: { note: "b" } } },
    ]);
    expect(settled).toEqual({ kind: "transform-conflict", key: "note" });
  });

  test("a post decision on a pre point fails closed", () => {
    const settled = settlePreHookDecisions([
      {
        hookId: "wrong",
        decision: { kind: "propose-follow-up", followUp: { code: "x", reason: "y" } },
      },
    ]);
    expect(settled.kind).toBe("failed-closed");
  });
});

describe("post-hook settlement", () => {
  test("records annotations and follow-ups without rewriting terminals", () => {
    const settled = settlePostHookDecisions([
      { hookId: "ann", decision: { kind: "annotate", annotations: { k: "v" } } },
      {
        hookId: "next",
        decision: { kind: "propose-follow-up", followUp: { code: "follow", reason: "later" } },
      },
      { hookId: "slow", decision: { kind: "allow" }, failed: { reason: "timed-out" } },
    ]);
    expect(settled.kind).toBe("recorded");
    if (settled.kind !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(settled.annotations).toEqual([{ key: "k", value: "v", hookId: "ann" }]);
    expect(settled.followUps).toEqual([{ code: "follow", reason: "later", hookId: "next" }]);
    expect(settled.failures).toEqual([{ hookId: "slow", reason: "timed-out" }]);
  });

  test("rejects a deny that would rewrite an observed result", () => {
    const settled = settlePostHookDecisions([
      { hookId: "bad", decision: { kind: "deny", reason: "nope" } },
    ]);
    expect(settled).toEqual({ kind: "illegal-rewrite", hookId: "bad" });
  });
});

describe("recursion", () => {
  test("denies depth beyond the bound", () => {
    expect(
      isRecursionDenied({
        point: "before-capability-invocation",
        phase: "pre",
        invocationId: invocationId.from("inv-1"),
        capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
        catalogGeneration: generation,
        registrationGeneration: generation,
        deadline: null,
        recursionDepth: 2,
        reentryKey: "inv-1:before-capability-invocation",
        payload: {},
        observedOutcome: null,
      }),
    ).toBe(true);
  });
});
