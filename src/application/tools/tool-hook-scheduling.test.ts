import { expect, test } from "bun:test";
import { hookRegistrationSchema } from "../../domain/extensions/hook-handlers.ts";
import {
  capabilityId,
  configurationGeneration,
  createManualClock,
  duration,
  instant,
  invocationId,
} from "../../domain/foundation/index.ts";
import { withHookCatalog } from "../../domain/tools/tool-hook-envelope.ts";
import {
  createToolHookRegistry,
  type RecordedHookDecision,
  type RegisteredToolHook,
  type ToolHookEnvelope,
} from "../../domain/tools/tool-hooks.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";

const generation = configurationGeneration.from(0);
const pre = "before-capability-invocation";
const post = "after-capability-invocation";
function envelope(point: ToolHookEnvelope["point"] = pre, id = "subject") {
  return withHookCatalog({
    point,
    phase: point === pre ? "pre" : "post",
    invocationId: invocationId.from(id),
    capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
    catalogGeneration: generation,
    registrationGeneration: generation,
    deadline: null,
    recursionDepth: 0,
    reentryKey: id,
    payload: { path: "src/main.ts" },
    observedOutcome:
      point === pre ? null : { status: "completed", output: {}, effect: "completed" },
  });
}
function hook(id: string, overrides: Partial<RegisteredToolHook> = {}): RegisteredToolHook {
  return { id, point: pre, priority: 0, run: () => ({ kind: "allow" }), ...overrides };
}
function registry(hooks: RegisteredToolHook[]) {
  const result = createToolHookRegistry(generation, hooks);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
test("topology precedes priority, source and UTF-8 identity, independent of input order", () => {
  const hooks = [
    hook("dependent", { priority: 100, after: ["last"] }),
    hook("last", { source: "development" }),
    hook("z", { source: "user" }),
    hook("a", { source: "user" }),
    hook("builtin"),
  ];
  for (const input of [hooks, [...hooks].reverse(), [...hooks.slice(2), ...hooks.slice(0, 2)]])
    expect(registry(input).hooks.map((h) => h.id)).toEqual([
      "builtin",
      "a",
      "z",
      "last",
      "dependent",
    ]);
  for (const [input, code] of [
    [[hook("a", { after: ["missing"] })], "missing-hook-dependency"],
    [[hook("a", { after: ["b"] }), hook("b", { after: ["a"] })], "hook-dependency-cycle"],
    [[hook("a", { after: ["b"] }), hook("b", { point: post })], "missing-hook-dependency"],
    [[hook("a"), hook("a")], "duplicate-hook"],
  ] as const)
    expect(createToolHookRegistry(generation, input)).toMatchObject({ ok: false, error: { code } });
});
test("a nonmatching filter records a skip before preparation or callback execution", async () => {
  let calls = 0;
  const records: RecordedHookDecision[] = [];
  const runner = createToolHookRunner({
    clock: createManualClock(instant(0)),
    registry: registry([
      hook("filtered", {
        registration: hookRegistrationSchema.parse({
          version: 1,
          point: pre,
          pointVersion: 1,
          mode: "sync",
          handler: { kind: "builtin", id: "filtered" },
          filters: [{ field: "capabilityId", operator: "exact", value: "other" }],
        }),
        run: () => {
          calls++;
          return { kind: "deny", reason: "must-not-run" };
        },
      }),
    ]),
  });
  expect(
    (
      await runner.runPre({
        envelope: envelope(),
        signal: AbortSignal.abort(),
        onDecision: async (r) => {
          records.push(r);
        },
      })
    ).kind,
  ).toBe("allowed");
  expect(calls).toBe(0);
  expect(records[0]?.execution).toMatchObject({ state: "skipped", cleanup: "not-started" });
});
test("revocation cancels the captured generation; replacing a registry alone does not", async () => {
  const clock = createManualClock(instant(0));
  const revoked = new AbortController();
  const started = Promise.withResolvers<void>();
  let observed: AbortSignal | undefined;
  const runner = createToolHookRunner({
    clock,
    registry: registry([
      hook("bound", {
        revoked: revoked.signal,
        run: async (_e, context) => {
          observed = context.signal;
          started.resolve();
          await clock.waitUntil(instant(100), context.signal);
          return { kind: "allow" };
        },
      }),
    ]),
    timeoutMs: 1000,
  });
  const result = runner.runPre({ envelope: envelope(), signal: new AbortController().signal });
  await started.promise;
  registry([hook("replacement")]);
  expect(observed?.aborted).toBe(false);
  revoked.abort();
  await clock.advance(duration(0));
  expect(await result).toMatchObject({ kind: "failed-closed", reason: "revoked" });
  expect(observed?.aborted).toBe(true);
});
test("local elapsed work shares the pre/post ceiling and fences late completion", async () => {
  const clock = createManualClock(instant(0));
  const records: RecordedHookDecision[] = [];
  let calls = 0;
  const budget = { startedAt: 0, spent: { local: 1900, remote: 0, evaluator: 0 } };
  const runner = createToolHookRunner({
    clock,
    timeoutMs: 1000,
    registry: registry([
      hook("slow", {
        run: async (_e, context) => {
          calls++;
          await clock.waitUntil(instant(1000), context.signal);
          return { kind: "allow" };
        },
      }),
      hook("post", {
        point: post,
        run: () => {
          calls++;
          return { kind: "annotate", annotations: {} };
        },
      }),
    ]),
  });
  const pending = runner.runPre({
    budget,
    envelope: envelope(),
    signal: new AbortController().signal,
    onDecision: async (r) => {
      records.push(r);
    },
  });
  await clock.advance(duration(100));
  expect((await pending).kind).toBe("failed-closed");
  await runner.runPost({
    budget,
    envelope: envelope(post),
    signal: new AbortController().signal,
    onDecision: async (r) => {
      records.push(r);
    },
  });
  expect(calls).toBe(1);
  expect(records.map((r) => r.execution?.state)).toEqual(["settled", "not-started"]);
});
test("async observers use four shared slots, sixteen pending entries, and drain on shutdown", async () => {
  const clock = createManualClock(instant(0));
  const resources = createProductResources(clock);
  const tasks = Array.from({ length: 21 }, () => resources.openTask("test"));
  const records: RecordedHookDecision[] = [];
  let active = 0;
  let maximum = 0;
  const runner = createToolHookRunner({
    clock,
    registry: registry([
      hook("observer", {
        point: post,
        registration: hookRegistrationSchema.parse({
          version: 1,
          point: post,
          pointVersion: 1,
          mode: "async",
          timeoutMs: 1000,
          handler: { kind: "builtin", id: "observer" },
        }),
        run: async (_e, context) => {
          active++;
          maximum = Math.max(active, maximum);
          await clock.waitUntil(instant(10000), context.signal);
          active--;
          return { kind: "observe", annotations: {} };
        },
      }),
    ]),
  });
  for (const [i, task] of tasks.entries()) {
    await runner.runPost({
      envelope: envelope(post, `subject-${i}`),
      signal: new AbortController().signal,
      task,
      resourceOwner: resources,
      onDecision: async (r) => {
        records.push(r);
      },
    });
    await clock.advance(duration(0));
  }
  expect(maximum).toBe(4);
  expect(records.filter((r) => r.execution?.state === "queued")).toHaveLength(20);
  expect(records.filter((r) => r.execution?.state === "dropped")).toHaveLength(1);
  const captured = records[0]?.evidence?.health.generation;
  expect(captured).toMatch(/^sha256:/);
  expect(records.every((r) => r.evidence?.health.generation === captured)).toBe(true);
  resources.shutdown();
  await clock.advance(duration(1000));
  expect(active).toBe(0);
  expect(records.filter((r) => r.execution?.state === "settled")).toHaveLength(4);
  for (const task of tasks) task.close();
  expect(resources.report().tasks).toBe(0);
});
test("all handler classes share order and enclosing limits without borrowing unused class budget", async () => {
  const clock = createManualClock(instant(0));
  const resources = createProductResources(clock);
  const task = resources.openTask("mixed");
  const observed: [string, number][] = [];
  const handlers = [
    { kind: "builtin", id: "local" },
    { kind: "http-v1", url: "https://example.invalid/hook" },
    { kind: "prompt-evaluator-v1", bindingId: "evaluator", instructions: "hook.txt" },
  ] as const;
  const hooks = handlers.map((handler, index) =>
    hook(`h${index}`, {
      after: index ? [`h${index - 1}`] : [],
      registration: hookRegistrationSchema.parse({
        version: 1,
        point: pre,
        pointVersion: 1,
        mode: "sync",
        nonlocalOptIn: true,
        handler,
      }),
      run: (_envelope, context) => {
        observed.push([handler.kind, context.expiresAt]);
        return { kind: "observe" };
      },
    }),
  );
  const runner = createToolHookRunner({ clock, registry: registry(hooks) });
  expect(
    (await runner.runPre({ envelope: envelope(), signal: new AbortController().signal, task }))
      .kind,
  ).toBe("allowed");
  expect(observed).toEqual([
    ["builtin", 50],
    ["http-v1", 5000],
    ["prompt-evaluator-v1", 10000],
  ]);
  const exhausted = resources.openTask("mixed-exhausted");
  const result = await runner.runPre({
    envelope: envelope(pre, "exhausted"),
    signal: new AbortController().signal,
    task: exhausted,
    budget: { startedAt: 0, spent: { local: 0, remote: 20000, evaluator: 0 } },
  });
  expect(result).toMatchObject({ kind: "failed-closed", hookId: "h1" });
  expect(observed).toHaveLength(4);
  const whole = await runner.runPre({
    envelope: envelope(pre, "whole"),
    signal: new AbortController().signal,
    task: exhausted,
    budget: { startedAt: -60000, spent: { local: 0, remote: 0, evaluator: 0 } },
  });
  expect(whole).toMatchObject({ kind: "failed-closed", hookId: "h0" });
  expect(observed).toHaveLength(4);
  task.close();
  exhausted.close();
  resources.shutdown();
});
test("every source rank is deterministic and owner-qualified bytes break equal rank ties", () => {
  const sources = ["builtin", "user", "workspace", "session", "process", "development"] as const;
  expect(
    registry([...sources].reverse().map((source) => hook(source, { source }))).hooks.map(
      (h) => h.source,
    ),
  ).toEqual([...sources]);
  expect(
    registry([hook("z", { owner: "a" }), hook("a", { owner: "a.b" })]).hooks.map((h) => h.owner),
  ).toEqual(["a.b", "a"]);
});

test("implicit and explicit builtin identity cannot create an unresolved execution tie", () => {
  expect(
    createToolHookRegistry(generation, [hook("same"), hook("same", { owner: "builtin" })]),
  ).toMatchObject({ ok: false, error: { code: "duplicate-hook" } });
});
