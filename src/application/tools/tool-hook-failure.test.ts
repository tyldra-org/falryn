import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { hookRegistrationSchema } from "../../domain/extensions/hook-handlers.ts";
import { hookDecisionBinding } from "../../domain/extensions/hook-protocol.ts";
import {
  capabilityId,
  configurationGeneration,
  createManualClock,
  duration,
  instant,
  invocationId,
} from "../../domain/foundation/index.ts";
import { type HookHandlerFacts, hookHandlerFactsSchema } from "../../domain/tools/hook-evidence.ts";
import { createMemoryHookHealth, inspectHookHealth } from "../../domain/tools/hook-health.ts";
import { withHookCatalog } from "../../domain/tools/tool-hook-envelope.ts";
import {
  createToolHookRegistry,
  type RecordedHookDecision,
  type RegisteredToolHook,
  type ToolHookDecision,
  type ToolHookEnvelope,
} from "../../domain/tools/tool-hooks.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { HookExecutionError } from "./tool-hook-invocation.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";

const pre = "before-capability-invocation";
const post = "after-capability-invocation";
const generation = configurationGeneration.from(0);
const secret = "sk-hook-canary-do-not-retain-abcdef123456";
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
    payload: { path: "src/main.ts", token: secret },
    observedOutcome:
      point === pre ? null : { status: "completed", output: { answer: 42 }, effect: "completed" },
  });
}
function registry(hooks: RegisteredToolHook[]) {
  const value = createToolHookRegistry(generation, hooks);
  if (!value.ok) throw new Error(value.error.code);
  return value.value;
}
test.each([pre, post] as const)(
  "%s quarantines exactly the failing hook while preserving the point policy",
  async (point) => {
    let calls = 0;
    let control = 0;
    const records: RecordedHookDecision[] = [];
    const hooks = registry([
      {
        id: "failure",
        point,
        priority: 2,
        run() {
          calls++;
          throw new Error(secret, { cause: new Error(`https://example.test/?key=${secret}`) });
        },
      },
      {
        id: "control",
        point,
        priority: 1,
        run() {
          control++;
          return point === pre
            ? { kind: "allow" }
            : { kind: "annotate", annotations: { valid: "yes" } };
        },
      },
    ]);
    for (let i = 0; i < 4; i++) {
      // A new turn/gateway owner still uses the registry's health owner.
      const runner = createToolHookRunner({
        clock: createManualClock(instant(0)),
        registry: hooks,
      });
      const input = {
        envelope: envelope(point, `subject-${i}`),
        signal: new AbortController().signal,
        onDecision: async (record: RecordedHookDecision) => {
          records.push(record);
        },
      };
      const result = point === pre ? await runner.runPre(input) : await runner.runPost(input);
      expect(result.kind).toBe(point === pre ? "failed-closed" : "recorded");
    }
    expect(calls).toBe(3);
    expect(control).toBe(point === pre ? 0 : 4);
    expect(records.filter((r) => r.hookId === "failure").at(-1)).toMatchObject({
      failed: { reason: "hook-quarantined" },
      evidence: {
        health: { status: "quarantined", failures: 3 },
        remediation: "reactivate-validated-source",
      },
    });
    expect(JSON.stringify(records)).not.toContain(secret);
  },
);

test("secret-bearing typed errors and malformed decisions cannot enter retained diagnostics", async () => {
  for (const run of [
    () => {
      throw new HookExecutionError(secret);
    },
    () => ({ kind: "observe", unknown: { authorization: secret } }) as unknown as ToolHookDecision,
  ]) {
    const records: RecordedHookDecision[] = [];
    const runner = createToolHookRunner({
      clock: createManualClock(instant(0)),
      registry: registry([{ id: "bad", point: pre, priority: 0, run }]),
    });
    expect(
      (
        await runner.runPre({
          envelope: envelope(),
          signal: new AbortController().signal,
          onDecision: async (r) => {
            records.push(r);
          },
        })
      ).kind,
    ).toBe("failed-closed");
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[0]?.evidence?.diagnosticPolicy).toBe("facts-only");
  }
});

test("audit callback failures are typed and optional observers continue without rewriting settlement", async () => {
  let good = 0;
  const runner = createToolHookRunner({
    clock: createManualClock(instant(0)),
    registry: registry([
      { id: "first", point: post, priority: 1, run: () => ({ kind: "annotate", annotations: {} }) },
      {
        id: "second",
        point: post,
        priority: 0,
        run: () => {
          good++;
          return { kind: "annotate", annotations: {} };
        },
      },
    ]),
    onFact() {
      throw new Error(secret);
    },
  });
  const result = await runner.runPost({
    envelope: envelope(post),
    signal: new AbortController().signal,
    onDecision: async (r) => {
      if (r.hookId === "first") throw new Error(secret);
    },
  });
  expect(result).toMatchObject({
    kind: "recorded",
    failures: [{ hookId: "first", reason: "hook-audit-unavailable" }],
  });
  expect(good).toBe(1);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("non-cooperative timeout fences duplicate/late completion and blocks uncertain cleanup", async () => {
  const clock = createManualClock(instant(0));
  const result = Promise.withResolvers<ToolHookDecision>();
  const health = createMemoryHookHealth(canonicalDigest("binding"));
  let calls = 0;
  const records: RecordedHookDecision[] = [];
  const runner = createToolHookRunner({
    clock,
    timeoutMs: 10,
    registry: registry([
      {
        id: "late",
        point: pre,
        priority: 0,
        health,
        run() {
          calls++;
          return result.promise;
        },
      },
    ]),
  });
  const pending = runner.runPre({
    envelope: envelope(),
    signal: new AbortController().signal,
    onDecision: async (r) => {
      records.push(r);
    },
  });
  await clock.advance(duration(10));
  await clock.advance(duration(1000));
  expect((await pending).kind).toBe("failed-closed");
  result.resolve({ kind: "allow" });
  result.resolve({ kind: "deny", reason: secret });
  await clock.advance(duration(0));
  expect(records).toHaveLength(1);
  expect(inspectHookHealth(health)).toMatchObject({ status: "cleanup-uncertain", failures: 1 });
  expect(
    await runner.runPre({
      envelope: envelope(pre, "second"),
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ kind: "failed-closed", reason: "hook-cleanup-uncertain" });
  expect(calls).toBe(1);
});

test.each([
  [
    { kind: "http-v1", url: "https://example.test/" },
    {
      kind: "remote",
      transport: "http",
      status: "disconnected",
      httpStatus: null,
      schemaGeneration: null,
      response: "missing",
      omittedBytes: 42,
      effects: "unknown",
    },
  ],
  [
    {
      kind: "mcp-tool-v1",
      serverId: "server",
      toolId: "tool",
      schemaGeneration: 2,
      outputField: "decision",
    },
    {
      kind: "remote",
      transport: "mcp",
      status: "completed",
      httpStatus: null,
      schemaGeneration: 1,
      response: "stale",
      omittedBytes: 0,
      effects: "unknown",
    },
  ],
  [
    { kind: "prompt-evaluator-v1", bindingId: "evaluator", instructions: "judge.md" },
    {
      kind: "model",
      status: "completed",
      response: "refused",
      requests: 1,
      inputTokens: null,
      outputTokens: null,
      effects: "observed",
    },
  ],
  [
    { kind: "agent-evaluator-v1", bindingId: "evaluator", instructions: "judge.md" },
    {
      kind: "model",
      status: "timed-out",
      response: "missing",
      requests: 2,
      inputTokens: 14,
      outputTokens: null,
      effects: "unknown",
    },
  ],
])(
  "shared adapter failure receipts preserve %j without inventing usage or remote effects",
  async (handler, raw) => {
    const clock = createManualClock(instant(0));
    const resources = createProductResources(clock);
    const task = resources.openTask("hook-facts");
    const facts: HookHandlerFacts = hookHandlerFactsSchema.parse(raw);
    const records: RecordedHookDecision[] = [];
    const registration = hookRegistrationSchema.parse({
      version: 1,
      point: pre,
      pointVersion: 1,
      mode: "sync",
      nonlocalOptIn: true,
      handler,
    });
    const runner = createToolHookRunner({
      clock,
      registry: registry([
        {
          id: "adapter",
          point: pre,
          priority: 0,
          registration,
          run(_envelope, context) {
            context.report?.(facts);
            throw new HookExecutionError("hook-transport-failed");
          },
        },
      ]),
    });
    try {
      expect(
        (
          await runner.runPre({
            envelope: envelope(),
            task,
            resourceOwner: resources,
            signal: new AbortController().signal,
            onDecision: async (r) => {
              records.push(r);
            },
          })
        ).kind,
      ).toBe("failed-closed");
      expect(records[0]?.evidence?.handlerFacts).toEqual(facts);
      expect(JSON.stringify(records)).not.toContain(secret);
    } finally {
      task.close();
    }
  },
);

test("a handler cannot smuggle URL, header, prompt or elicitation data through typed evidence", async () => {
  const clock = createManualClock(instant(0));
  const resources = createProductResources(clock);
  const task = resources.openTask("invalid-facts");
  const records: RecordedHookDecision[] = [];
  const registration = hookRegistrationSchema.parse({
    version: 1,
    point: pre,
    pointVersion: 1,
    mode: "sync",
    nonlocalOptIn: true,
    handler: { kind: "http-v1", url: "https://example.test/" },
  });
  const runner = createToolHookRunner({
    clock,
    registry: registry([
      {
        id: "adapter",
        point: pre,
        priority: 0,
        registration,
        run(e, context) {
          context.report?.({
            kind: "remote",
            transport: "http",
            status: "completed",
            httpStatus: 200,
            schemaGeneration: null,
            response: "valid",
            omittedBytes: 0,
            effects: "unknown",
            headers: { Authorization: secret },
            url: `https://example.test/?token=${secret}`,
            prompt: secret,
            elicitation: { answer: secret },
          } as unknown as HookHandlerFacts);
          return { kind: "veto", reason: "blocked", binding: hookDecisionBinding(e.catalog) };
        },
      },
    ]),
  });
  try {
    expect(
      await runner.runPre({
        envelope: envelope(),
        task,
        resourceOwner: resources,
        signal: new AbortController().signal,
        onDecision: async (r) => {
          records.push(r);
        },
      }),
    ).toMatchObject({ kind: "failed-closed", reason: "invalid-handler-evidence" });
    expect(JSON.stringify(records)).not.toContain(secret);
  } finally {
    task.close();
  }
});

test("health persistence exceptions refuse required gates and cannot escape optional observers", async () => {
  for (const point of [pre, post] as const) {
    const health = createMemoryHookHealth(canonicalDigest("broken-store"));
    const records: RecordedHookDecision[] = [];
    const runner = createToolHookRunner({
      clock: createManualClock(instant(0)),
      registry: registry([
        {
          id: "store",
          point,
          priority: 0,
          health: {
            ...health,
            settle() {
              throw new Error(secret);
            },
          },
          run: () => ({ kind: "allow" }),
        },
      ]),
    });
    const input = {
      envelope: envelope(point),
      signal: new AbortController().signal,
      onDecision: async (r: RecordedHookDecision) => {
        records.push(r);
      },
    };
    const result = point === pre ? await runner.runPre(input) : await runner.runPost(input);
    expect(result.kind).toBe(point === pre ? "failed-closed" : "recorded");
    expect(records[0]).toMatchObject({
      failed: { reason: "hook-health-unavailable" },
      evidence: { health: { status: "unavailable" }, remediation: "restore-audit-store" },
    });
    expect(JSON.stringify(records)).not.toContain(secret);
  }
});
