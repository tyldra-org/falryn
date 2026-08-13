import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  authorizeToolInvocation,
  configurationGeneration,
  createManualClock,
  createToolHookRegistry,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  duration,
  EVENT_KINDS,
  instant,
  invocationId,
  type ToolHookEnvelope,
  type ToolManifestDocument,
  validateAndNormalizeInvocations,
} from "../domain/index.ts";
import { createRuntimeRedactor } from "./redaction.ts";
import { createToolHookRunner } from "./tool-hook-runner.ts";
import { envelopeToolResult } from "./tool-result-envelope.ts";
import { createToolWorkScheduler } from "./tool-work-scheduler.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathOutputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function document(): ToolManifestDocument {
  return {
    namespace: "workspace",
    name: "read_file",
    version: 1,
    source: "builtin",
    title: "read_file",
    description: "observation tool",
    effect: "observation",
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits({ maxInputBytes: 1024 }),
    concurrency: defaultConcurrencyContract(),
    resultProjection: defaultProjectionContract(),
  };
}

function authorizeObservation() {
  const entry = createToolRegistryEntry(document(), {
    inputSchema: pathSchema,
    outputSchema: pathOutputSchema,
    conflictKeysFor: () => [],
  });
  expect(entry.ok).toBe(true);
  if (!entry.ok) {
    throw new Error("expected entry");
  }
  const registry = createToolRegistry(generation, [entry.value]);
  expect(registry.ok).toBe(true);
  if (!registry.ok) {
    throw new Error("expected registry");
  }
  const validated = validateAndNormalizeInvocations({
    registry: registry.value,
    proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
    maxQueued: 8,
    nextInvocationId: () => invocationId.from("inv-1"),
  });
  expect(validated.ok).toBe(true);
  if (!validated.ok) {
    throw new Error("expected validate");
  }
  const ready = validated.value[0];
  if (ready === undefined) {
    throw new Error("expected invocation");
  }
  const authorized = authorizeToolInvocation({ invocation: ready });
  expect(authorized.ok).toBe(true);
  if (!authorized.ok) {
    throw new Error("expected authorize");
  }
  return authorized.value;
}

function envelopeFor(
  authorized: ReturnType<typeof authorizeObservation>,
  point: ToolHookEnvelope["point"],
  observedOutcome: ToolHookEnvelope["observedOutcome"] = null,
): ToolHookEnvelope {
  return {
    point,
    phase: point === "before-capability-invocation" ? "pre" : "post",
    invocationId: authorized.invocation.invocationId,
    capabilityId: authorized.invocation.entry.descriptor.id,
    catalogGeneration: generation,
    registrationGeneration: generation,
    deadline: null,
    recursionDepth: 0,
    reentryKey: `${authorized.invocation.invocationId}:${point}`,
    payload: authorized.invocation.input,
    observedOutcome,
  };
}

describe("tool pipeline seam #48–#53", () => {
  test("does not widen EVENT_KINDS for hook lifecycle facts", () => {
    expect(EVENT_KINDS).not.toContain("hook-point-entered");
    expect(EVENT_KINDS).not.toContain("hook-decided");
    expect(EVENT_KINDS).not.toContain("hook-point-settled");
  });

  test("a pre-hook deny never invokes ToolRunnerPort", async () => {
    const authorized = authorizeObservation();
    const registry = createToolHookRegistry(generation, [
      {
        id: "deny.read",
        point: "before-capability-invocation",
        priority: 1,
        run: (env) => {
          expect("runner" in env).toBe(false);
          return { kind: "deny", reason: "blocked" };
        },
      },
    ]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      throw new Error("expected hook registry");
    }
    const clock = createManualClock(instant(0));
    const hooks = createToolHookRunner({ clock, registry: registry.value });
    const pre = await hooks.runPre({
      envelope: envelopeFor(authorized, "before-capability-invocation"),
      signal: new AbortController().signal,
    });
    expect(pre.kind).toBe("denied");

    let runnerCalls = 0;
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async () => {
          runnerCalls += 1;
          return { status: "completed", output: { content: "nope" }, effect: "completed" };
        },
      },
    });
    if (pre.kind === "allowed") {
      await scheduler.run({
        items: [{ authorized }],
        joinPolicy: "all",
        signal: new AbortController().signal,
      });
    }
    expect(runnerCalls).toBe(0);
  });

  test("post-hooks cannot flip a failed outcome to completed", async () => {
    const authorized = authorizeObservation();
    const clock = createManualClock(instant(0));
    let runnerCalls = 0;
    const scheduler = createToolWorkScheduler({
      clock,
      runner: {
        execute: async () => {
          runnerCalls += 1;
          return { status: "failed", reason: "runner-error", effect: "none" };
        },
      },
    });
    const allowRegistry = createToolHookRegistry(generation, [
      {
        id: "allow.read",
        point: "before-capability-invocation",
        priority: 1,
        run: () => ({ kind: "allow" }),
      },
      {
        id: "rewrite.fail",
        point: "after-capability-invocation",
        priority: 1,
        run: () => ({ kind: "deny", reason: "pretend-success" }),
      },
    ]);
    expect(allowRegistry.ok).toBe(true);
    if (!allowRegistry.ok) {
      throw new Error("expected hook registry");
    }
    const hooks = createToolHookRunner({ clock, registry: allowRegistry.value });
    const pre = await hooks.runPre({
      envelope: envelopeFor(authorized, "before-capability-invocation"),
      signal: new AbortController().signal,
    });
    expect(pre.kind).toBe("allowed");

    const batch = await scheduler.run({
      items: [{ authorized }],
      joinPolicy: "all",
      signal: new AbortController().signal,
    });
    expect(batch.kind).toBe("completed");
    if (batch.kind !== "completed") {
      throw new Error("expected batch");
    }
    const record = batch.records[0];
    if (record === undefined) {
      throw new Error("expected record");
    }
    expect(record.outcome.status).toBe("failed");
    expect(runnerCalls).toBe(1);

    const enveloped = envelopeToolResult({
      invocationId: authorized.invocation.invocationId,
      capabilityId: authorized.invocation.entry.descriptor.id,
      version: authorized.invocation.entry.manifest.version,
      catalogGeneration: generation,
      outputSchema: pathOutputSchema,
      maxOutputBytes: 4096,
      outcome: record.outcome,
      artifacts: [],
      diagnostics: [],
      timing: {
        startedAt: instant(0),
        endedAt: instant(1),
        queueMs: duration(0),
        executeMs: duration(1),
        captureMs: duration(0),
      },
      persistFailed: false,
      captureOverflow: false,
      projection: defaultProjectionContract(),
      redactor: createRuntimeRedactor(),
    });
    expect(enveloped.result.status).toBe("failed");

    const post = await hooks.runPost({
      envelope: envelopeFor(authorized, "after-capability-invocation", record.outcome),
      signal: new AbortController().signal,
    });
    expect(post.kind).toBe("illegal-rewrite");
    expect(enveloped.result.status).toBe("failed");
  });
});
