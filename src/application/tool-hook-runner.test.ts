import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createManualClock,
  createToolHookRegistry,
  duration,
  instant,
  invocationId,
  type ToolHookEnvelope,
  type ToolLifecycleFact,
} from "../domain/index.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";

const generation = configurationGeneration.from(0);

function envelope(
  point: ToolHookEnvelope["point"],
  overrides: Partial<ToolHookEnvelope> = {},
): ToolHookEnvelope {
  return {
    point,
    phase: point === "before-capability-invocation" ? "pre" : "post",
    invocationId: invocationId.from("inv-1"),
    capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
    catalogGeneration: generation,
    registrationGeneration: generation,
    deadline: null,
    recursionDepth: 0,
    reentryKey: `inv-1:${point}`,
    payload: { path: "a.ts" },
    observedOutcome: null,
    ...overrides,
  };
}

describe("createToolHookRunner", () => {
  test("runs pre-hooks in order and denies before any later hook", async () => {
    const seen: string[] = [];
    const registry = createToolHookRegistry(generation, [
      {
        id: "second",
        point: "before-capability-invocation",
        priority: 1,
        run: () => {
          seen.push("second");
          return { kind: "allow" };
        },
      },
      {
        id: "first",
        point: "before-capability-invocation",
        priority: 10,
        run: () => {
          seen.push("first");
          return { kind: "deny", reason: "blocked" };
        },
      },
    ]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      throw new Error("expected registry");
    }
    const facts: ToolLifecycleFact[] = [];
    const runner = createToolHookRunner({
      clock: createManualClock(instant(0)),
      registry: registry.value,
      onFact: (fact) => facts.push(fact),
    });
    const result = await runner.runPre({
      envelope: envelope("before-capability-invocation"),
      signal: new AbortController().signal,
    });
    expect(seen).toEqual(["first"]);
    expect(result).toEqual({ kind: "denied", reason: "blocked", hookId: "first" });
    expect(facts.map((fact) => fact.kind)).toEqual([
      "hook-point-entered",
      "hook-decided",
      "hook-point-settled",
    ]);
  });

  test("fail-open post timeout records a failure and keeps the observed result", async () => {
    const clock = createManualClock(instant(0));
    const registry = createToolHookRegistry(generation, [
      {
        id: "hang",
        point: "after-capability-invocation",
        priority: 1,
        run: () =>
          clock.waitUntil(instant(10_000)).then(() => ({ kind: "annotate", annotations: {} })),
      },
    ]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      throw new Error("expected registry");
    }
    const runner = createToolHookRunner({
      clock,
      registry: registry.value,
      timeoutMs: 50,
    });
    const pending = runner.runPost({
      envelope: envelope("after-capability-invocation", {
        observedOutcome: { status: "failed", reason: "runner-error", effect: "none" },
      }),
      signal: new AbortController().signal,
    });
    await clock.advance(duration(50));
    const result = await pending;
    expect(result.kind).toBe("recorded");
    if (result.kind !== "recorded") {
      throw new Error("expected recorded");
    }
    expect(result.failures).toEqual([{ hookId: "hang", reason: "timed-out" }]);
  });

  test("fail-closed pre timeout blocks execution", async () => {
    const clock = createManualClock(instant(0));
    const registry = createToolHookRegistry(generation, [
      {
        id: "hang",
        point: "before-capability-invocation",
        priority: 1,
        run: () => clock.waitUntil(instant(10_000)).then(() => ({ kind: "allow" })),
      },
    ]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      throw new Error("expected registry");
    }
    const runner = createToolHookRunner({
      clock,
      registry: registry.value,
      timeoutMs: 50,
    });
    const pending = runner.runPre({
      envelope: envelope("before-capability-invocation"),
      signal: new AbortController().signal,
    });
    await clock.advance(duration(50));
    const result = await pending;
    expect(result.kind).toBe("failed-closed");
  });
});
