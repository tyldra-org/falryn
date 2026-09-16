import { expect, test } from "bun:test";
import { hookFixtureDigest as digest, hookFixtureEnvelope } from "./hook-fixtures.ts";
import { HOOK_POINTS, inspectHookPoints, parseHookEnvelope } from "./hook-points.ts";

test("the closed catalog declares every event family and only composed publishers are available", () => {
  const expected =
    `session.start session.end turn.start turn.complete task.create task.complete workflow.complete
user.submit user.prompt.expand instructions.loaded context.plan.before context.plan.after context.compact.before context.compact.after
model.switch.before model.switch.after provider.attempt.before provider.attempt.after before-capability-invocation after-capability-invocation
capability.disclose.before capability.invoke.failure capability.batch.complete confirmation.request confirmation.denied artifact.retain.before artifact.export.before
extension.connect extension.catalog.change mcp.elicitation mcp.elicitation.result job.start job.stop subagent.start subagent.stop agent.idle
workspace.cwd.change workspace.root.add workspace.file.change worktree.create worktree.remove configuration.change environment.prepare.before environment.prepare.after
notification.publish message.project diagnostic.project`.split(/\s+/u);
  expect(Object.keys(HOOK_POINTS).sort()).toEqual(expected.sort());
  const inspected = inspectHookPoints();
  expect(inspected.filter((p) => p.availability === "available").map((p) => p.point)).toEqual([
    "before-capability-invocation",
    "after-capability-invocation",
  ]);
  for (const row of inspected) {
    expect(row.inputSchema.additionalProperties).toBe(false);
    expect(row.observationEvent).toBe("hook-point-entered");
    expect(row.outcomeEvent).toBe("hook-point-settled");
    expect(row.producer.length).toBeGreaterThan(0);
    if (row.availability === "unavailable") expect(row.publisher).toBeNull();
  }
});

test("unknown aliases, versions, payload fields and runtime references fail closed", () => {
  const valid = hookFixtureEnvelope();
  for (const change of [
    { point: "capability.invoke.before" },
    { pointVersion: 2 },
    { version: 2 },
    { environment: {} },
    { payload: { ...valid.payload, callback: () => {} } },
    { registrationGeneration: -1 },
    { recursionDepth: 2 },
  ])
    expect(() => parseHookEnvelope({ ...valid, ...change })).toThrow();
  expect(Object.isFrozen(valid)).toBe(true);
  expect(Object.isFrozen(valid.payload)).toBe(true);
  expect(Object.isFrozen(valid.correlation)).toBe(true);
});

test("task completion carries committed revision and provenance without completing groups or aliasing jobs", () => {
  const payload = {
    taskId: "todo:1",
    revision: 8,
    affectedNodeIds: ["node:1"],
    source: { sourceId: "user", digest },
    nodeKind: "work-item" as const,
    terminal: "completed" as const,
    effect: "completed" as const,
  };
  const completion = hookFixtureEnvelope("task.complete", payload);
  expect(completion.payload).toEqual(payload);
  for (const change of [
    { nodeKind: "group" },
    { groupCount: 1 },
    { terminal: "cancel-requested" },
    { revision: -1 },
  ])
    expect(() => hookFixtureEnvelope("task.complete", { ...payload, ...change })).toThrow();
  expect(() => hookFixtureEnvelope("job.stop", payload)).toThrow();
  expect(() => hookFixtureEnvelope("workflow.complete", payload)).toThrow();
  expect(() => hookFixtureEnvelope("session.end", payload)).toThrow();
  expect(HOOK_POINTS["task.complete"].mutableFields).toEqual([]);
});

test("model observations preserve requested, resolved and actual processing without arbitrary headers", () => {
  const payload = {
    attemptId: "attempt:1",
    bindingId: "binding:2",
    processing: {
      requested: "fast",
      resolved: "standard",
      actual: "standard",
      disposition: "downgraded" as const,
    },
    terminal: "completed" as const,
    effect: "completed" as const,
  };
  expect(hookFixtureEnvelope("provider.attempt.after", payload).payload).toEqual(payload);
  expect(() =>
    hookFixtureEnvelope("provider.attempt.after", { ...payload, headers: { speed: "fast" } }),
  ).toThrow();
  expect(() =>
    hookFixtureEnvelope("provider.attempt.after", {
      ...payload,
      processing: { ...payload.processing, billing: "override" },
    }),
  ).toThrow();
  expect(HOOK_POINTS["provider.attempt.after"].mutableFields).toEqual([]);
});
