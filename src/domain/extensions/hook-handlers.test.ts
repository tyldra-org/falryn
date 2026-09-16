import { expect, test } from "bun:test";
import { externalHookFixture } from "./hook-fixtures.ts";
import {
  hookAuthorSchema,
  hookBudgetClass,
  hookRegistrationAvailability,
  hookRegistrationSchema,
} from "./hook-handlers.ts";

test("one handler union owns explicit local, remote and evaluator declarations", () => {
  const handlers = [
    { kind: "builtin", id: "host.audit" },
    externalHookFixture.handler,
    {
      kind: "http-v1",
      url: "https://hooks.example.test/observe",
      credentialReference: "vault:hook",
    },
    {
      kind: "mcp-tool-v1",
      serverId: "server:1",
      toolId: "audit",
      schemaGeneration: 5,
      outputField: "result",
    },
    { kind: "prompt-evaluator-v1", bindingId: "binding:1", instructions: "hooks/evaluate.md" },
    { kind: "agent-evaluator-v1", bindingId: "binding:1", instructions: "hooks/evaluate.md" },
  ];
  expect(
    handlers.map((handler) =>
      hookBudgetClass(
        hookRegistrationSchema.parse({ ...externalHookFixture, handler, nonlocalOptIn: true })
          .handler,
      ),
    ),
  ).toEqual(["local", "local", "remote", "remote", "evaluator", "evaluator"]);
  expect(
    hookRegistrationAvailability(
      hookRegistrationSchema.parse({ ...externalHookFixture, handler: handlers[0] }),
    ),
  ).toEqual({ status: "available" });
  expect(hookRegistrationAvailability(hookRegistrationSchema.parse(externalHookFixture))).toEqual({
    status: "unavailable",
    code: "hook-handler-unavailable",
  });
  expect(
    hookRegistrationAvailability(
      hookRegistrationSchema.parse({ ...externalHookFixture, point: "turn.complete" }),
    ),
  ).toEqual({ status: "unavailable", code: "hook-publisher-unavailable" });
  expect(hookAuthorSchema("before-capability-invocation").registration.additionalProperties).toBe(
    false,
  );
});

test("registration rejects unknown metadata, invalid modes, unsafe filters and implicit budget widening", () => {
  for (const change of [
    { point: "arbitrary.execute" },
    { pointVersion: 2 },
    { version: 2 },
    { unknown: true },
    { mode: "async" },
    { timeoutMs: 1001 },
    { handler: { ...externalHookFixture.handler, entrypoint: "../outside.ts" } },
    { handler: { ...externalHookFixture.handler, shell: true } },
    { handler: { kind: "http-v1", url: "https://hooks.example.test/" } },
    {
      handler: { kind: "http-v1", url: "https://user:secret@hooks.example.test/" },
      nonlocalOptIn: true,
    },
    {
      point: "session.end",
      handler: { kind: "http-v1", url: "https://hooks.example.test/" },
      nonlocalOptIn: true,
    },
    {
      point: "turn.complete",
      handler: { kind: "http-v1", url: "https://hooks.example.test/" },
      nonlocalOptIn: true,
    },
    {
      point: "provider.attempt.before",
      handler: { kind: "prompt-evaluator-v1", bindingId: "b", instructions: "i.md" },
      nonlocalOptIn: true,
    },
    { filters: [{ field: "credential", operator: "exact", value: "secret" }] },
    { filters: [{ field: "capabilityId", operator: "glob", value: "*" }] },
    {
      point: "workspace.file.change",
      filters: [{ field: "paths", operator: "glob", value: "../**" }],
    },
  ])
    expect(hookRegistrationSchema.safeParse({ ...externalHookFixture, ...change }).success).toBe(
      false,
    );
  expect(
    hookRegistrationSchema.safeParse({
      ...externalHookFixture,
      point: "workspace.file.change",
      filters: [{ field: "paths", operator: "glob", value: "src/**/*.ts" }],
    }).success,
  ).toBe(true);
  expect(
    hookRegistrationSchema.safeParse({
      ...externalHookFixture,
      point: "turn.complete",
      mode: "async",
      nonlocalOptIn: true,
      handler: { kind: "http-v1", url: "https://hooks.example.test/" },
      timeoutMs: 10000,
    }).success,
  ).toBe(true);
});
