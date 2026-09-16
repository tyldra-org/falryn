import { describe, expect, test } from "bun:test";

import { configurationGeneration } from "../foundation/index.ts";
import {
  createToolHookRegistry,
  failurePostureForHookPoint,
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
  test("runtime registration rejects unknown points and versions, and snapshots admitted declarations", () => {
    const valid = hook("valid", "before-capability-invocation", 0);
    for (const [change, code] of [
      [{ point: "capability.invoke.before" }, "unknown-hook-point"],
      [{ point: "turn.complete" }, "hook-publisher-unavailable"],
      [{ pointVersion: 2 }, "incompatible-hook-version"],
      [{ environment: {} }, "invalid-hook-declaration"],
    ] as const) {
      const result = createToolHookRegistry(generation, [
        { ...valid, ...change } as unknown as RegisteredToolHook,
      ]);
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
    const registered = createToolHookRegistry(generation, [valid]);
    if (!registered.ok) throw new Error(registered.error.code);
    expect(Object.isFrozen(registered.value.hooks)).toBe(true);
    expect(Object.isFrozen(registered.value.hooks[0])).toBe(true);
    expect(registered.value.hooks[0]?.pointVersion).toBe(1);
    expect(registered.value.hooks[0]).not.toBe(valid);
  });
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
    expect(isRecursionDenied({ recursionDepth: 2 })).toBe(true);
  });
});

test("the combined annotation result stays within the point bound", () => {
  const decisions = Array.from({ length: 9 }, (_, index) => ({
    hookId: `h${index}`,
    decision: { kind: "observe" as const, annotations: { [`k${index}`]: "value" } },
  }));
  expect(settlePreHookDecisions(decisions)).toMatchObject({
    kind: "failed-closed",
    reason: "annotation-bound",
  });
  const post = settlePostHookDecisions(decisions);
  expect(post).toMatchObject({ kind: "recorded", failures: [{ reason: "annotation-bound" }] });
  if (post.kind === "recorded") expect(post.annotations).toHaveLength(8);
});
