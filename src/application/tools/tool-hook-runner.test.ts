import { describe, expect, test } from "bun:test";
import {
  capabilityId,
  configurationGeneration,
  createManualClock,
  duration,
  instant,
  invocationId,
} from "../../domain/foundation/index.ts";
import {
  createToolHookRegistry,
  type ToolHookEnvelope,
  type ToolLifecycleFact,
} from "../../domain/tools/index.ts";
import { withHookCatalog } from "../../domain/tools/tool-hook-envelope.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";

const generation = configurationGeneration.from(0);

function envelope(
  point: ToolHookEnvelope["point"],
  overrides: Partial<ToolHookEnvelope> = {},
): ToolHookEnvelope {
  return withHookCatalog({
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
    observedOutcome:
      point === "after-capability-invocation"
        ? { status: "completed", output: {}, effect: "completed" }
        : null,
    ...overrides,
  });
}

describe("createToolHookRunner", () => {
  test("freezes callback snapshots and refuses malformed, oversized and cancelled invocation before calling", async () => {
    const original = envelope("before-capability-invocation");
    let calls = 0;
    const registered = createToolHookRegistry(generation, [
      {
        id: "snapshot",
        point: "before-capability-invocation",
        priority: 0,
        run: (snapshot) => {
          calls++;
          expect(snapshot).not.toBe(original);
          expect(Object.isFrozen(snapshot.payload)).toBe(true);
          expect(() => {
            (snapshot.payload as Record<string, unknown>).path = "outside";
          }).toThrow();
          return { kind: "allow" };
        },
      },
    ]);
    if (!registered.ok) throw new Error(registered.error.code);
    const runner = createToolHookRunner({
      clock: createManualClock(instant(0)),
      registry: registered.value,
    });
    await runner.runPre({ envelope: original, signal: new AbortController().signal });
    expect(calls).toBe(1);
    expect(original.payload).toEqual({ path: "a.ts" });
    for (const invalid of [
      {
        ...original,
        registrationGeneration: configurationGeneration.from(1),
        catalog: { ...original.catalog, registrationGeneration: 1 },
      },
      { ...original, catalog: { ...original.catalog, pointVersion: 2 } },
      { ...original, payload: { callback: () => {} } },
      { ...original, payload: { path: "x".repeat(65536) } },
    ]) {
      const result = await runner.runPre({
        envelope: invalid as unknown as ToolHookEnvelope,
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe("failed-closed");
    }
    const cancelled = new AbortController();
    cancelled.abort();
    expect((await runner.runPre({ envelope: original, signal: cancelled.signal })).kind).toBe(
      "failed-closed",
    );
    expect(calls).toBe(1);
  });
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
