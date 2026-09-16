import { expect, test } from "bun:test";
import { externalHookFixture, hookFixtureDigest, hookFixtureEnvelope } from "./hook-fixtures.ts";
import { hookRegistrationSchema } from "./hook-handlers.ts";
import { HOOK_LIMITS, parseHookEnvelope } from "./hook-points.ts";
import {
  decodeHookInput,
  decodeHookResponse,
  encodeHookInput,
  hookDecisionBinding,
} from "./hook-protocol.ts";

const registration = hookRegistrationSchema.parse(externalHookFixture);
const input = {
  version: 1 as const,
  invocationId: "inv:1",
  contribution: { packageId: "package:1", contributionId: "hook:1", generation: 7 },
  envelope: hookFixtureEnvelope(),
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const response = (decision: Record<string, unknown>) =>
  bytes({
    version: 1,
    invocationId: "inv:1",
    decision:
      decision.kind === "observe"
        ? decision
        : { binding: hookDecisionBinding(input.envelope), ...decision },
  });

test("the v1 wire round trip is immutable, bounded and strictly correlated", () => {
  const unicode = { ...input, invocationId: "e\u0301\r\n" };
  // Control characters are not identities; content annotations remain exact Unicode.
  expect(() => encodeHookInput(unicode)).toThrow();
  expect(
    decodeHookResponse(
      response({ kind: "observe", annotations: { exact: "e\u0301\r\n" } }),
      input,
      registration,
    ),
  ).toEqual({ kind: "observe", annotations: { exact: "e\u0301\r\n" } });
  expect(decodeHookInput(encodeHookInput(input))).toEqual(input);
  expect(Object.isFrozen(decodeHookInput(encodeHookInput(input)).contribution)).toBe(true);
  expect(
    decodeHookResponse(
      response({ kind: "transform", annotations: { note: "reviewed" } }),
      input,
      registration,
    ),
  ).toEqual({
    kind: "transform",
    binding: hookDecisionBinding(input.envelope),
    annotations: { note: "reviewed" },
  });
  expect(
    decodeHookResponse(response({ kind: "veto", reason: "declined" }), input, registration).kind,
  ).toBe("veto");
  expect(
    decodeHookResponse(
      response({
        kind: "external-effect-request",
        request: { kind: "confirmation", reason: "check" },
      }),
      input,
      registration,
    ).kind,
  ).toBe("external-effect-request");
  const good = new TextDecoder().decode(response({ kind: "observe" }));
  for (const invalid of [
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode(`${good} {}`),
    new TextEncoder().encode(`${good}junk`),
    new TextEncoder().encode(good.replace('"version":1', '"version":1,"version":1')),
    bytes({ version: 2, invocationId: "inv:1", decision: { kind: "observe" } }),
    bytes({ version: 1, invocationId: "stale", decision: { kind: "observe" } }),
    response({ kind: "observe", environment: {} }),
    response({ kind: "transform", input: {} }),
    response({ kind: "observe", annotations: { note: "x".repeat(121) } }),
    response({
      kind: "observe",
      annotations: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "x"])),
    }),
    new Uint8Array(HOOK_LIMITS.responseBytes + 1),
  ])
    expect(() => decodeHookResponse(invalid, input, registration)).toThrow();
  expect(() => decodeHookInput(new Uint8Array(HOOK_LIMITS.inputBytes + 1))).toThrow(
    "hook-document-too-large",
  );
  expect(() => decodeHookInput(bytes({ ...input, credentials: {} }))).toThrow();
});

test("committed terminal facts, processing and stop outcomes cannot be rewritten", () => {
  const terminalInput = {
    ...input,
    envelope: hookFixtureEnvelope("turn.complete", {
      turnId: "turn:1",
      terminal: "cancelled",
      effect: "partial",
    }),
  };
  const terminalRegistration = hookRegistrationSchema.parse({
    ...externalHookFixture,
    point: "turn.complete",
  });
  for (const decision of [
    { kind: "veto", reason: "undo" },
    { kind: "transform", annotations: {} },
    { kind: "observe", terminal: "completed" },
  ])
    expect(() =>
      decodeHookResponse(response(decision), terminalInput, terminalRegistration),
    ).toThrow();
  expect(
    decodeHookResponse(response({ kind: "observe" }), terminalInput, terminalRegistration),
  ).toEqual({ kind: "observe" });
  const modelInput = {
    ...input,
    envelope: hookFixtureEnvelope("provider.attempt.before", {
      attemptId: "a",
      bindingId: "b",
      processing: {
        requested: "fast",
        resolved: "standard",
        actual: null,
        disposition: "downgraded",
      },
    }),
  };
  const modelRegistration = hookRegistrationSchema.parse({
    ...externalHookFixture,
    point: "provider.attempt.before",
  });
  expect(() =>
    decodeHookResponse(
      response({ kind: "transform", processing: { actual: "fast" } }),
      modelInput,
      modelRegistration,
    ),
  ).toThrow();
  const stopped = {
    ...input,
    envelope: parseHookEnvelope({ ...input.envelope, reason: "user-stop" }),
  };
  expect(() =>
    decodeHookResponse(response({ kind: "veto", reason: "block stop" }), stopped, registration),
  ).toThrow("hook-observation-only");
  const remote = hookRegistrationSchema.parse({
    ...externalHookFixture,
    nonlocalOptIn: true,
    handler: { kind: "http-v1", url: "https://example.test/" },
  });
  expect(() => decodeHookResponse(response({ kind: "observe" }), stopped, remote)).toThrow(
    "hook-stop-local-only",
  );
});

test("context additions stay bounded, attributed, untrusted and limited to the four pre-dispatch owners", () => {
  const evidence = [{ sourceId: "package:1", text: "context", trust: "untrusted" }];
  const source = { sourceId: "source:1", digest: hookFixtureDigest };
  const context = {
    contextId: "context:1",
    generation: 5,
    itemCount: 1,
    contentDigest: hookFixtureDigest,
  };
  for (const point of [
    "user.submit",
    "user.prompt.expand",
    "instructions.loaded",
    "context.plan.before",
  ] as const) {
    const envelope = hookFixtureEnvelope(
      point,
      point.startsWith("user.")
        ? { inputId: "input:1", contentDigest: hookFixtureDigest, source }
        : point === "instructions.loaded"
          ? { ...context, source }
          : context,
    );
    const declaration = hookRegistrationSchema.parse({ ...externalHookFixture, point });
    expect(
      decodeHookResponse(
        response({ kind: "observe", contextEvidence: evidence }),
        { ...input, envelope },
        declaration,
      ).kind,
    ).toBe("observe");
    for (const additions of [
      [{ ...evidence[0], trust: "system" }],
      [{ text: "missing source", trust: "untrusted" }],
      Array(9).fill(evidence[0]),
      [{ sourceId: "s", text: "é".repeat(4096), trust: "untrusted" }],
    ])
      expect(() =>
        decodeHookResponse(
          response({ kind: "observe", contextEvidence: additions }),
          { ...input, envelope },
          declaration,
        ),
      ).toThrow();
  }
  expect(() =>
    decodeHookResponse(
      response({ kind: "observe", contextEvidence: evidence }),
      input,
      registration,
    ),
  ).toThrow("hook-context-evidence-unavailable");
  const evaluator = hookRegistrationSchema.parse({
    ...externalHookFixture,
    nonlocalOptIn: true,
    handler: { kind: "agent-evaluator-v1", bindingId: "b", instructions: "i.md" },
  });
  expect(() =>
    decodeHookResponse(
      response({ kind: "observe" }),
      { ...input, envelope: parseHookEnvelope({ ...input.envelope, origin: "evaluator" }) },
      evaluator,
    ),
  ).toThrow("hook-evaluator-recursion");
  expect(() =>
    decodeHookResponse(response({ kind: "transform", annotations: {} }), input, evaluator),
  ).toThrow("hook-transform-unavailable");
});

test("mutation and veto bindings reject changed subjects, input digests and generations", () => {
  const binding = hookDecisionBinding(input.envelope);
  for (const changed of [
    { factId: "other" },
    { subjectId: "other" },
    { ownerGeneration: 6 },
    { configurationGeneration: 6 },
    { registrationGeneration: 8 },
    { payloadDigest: "b".repeat(64) },
  ]) {
    for (const decision of [
      { kind: "transform", binding: { ...binding, ...changed }, input: { path: "b" } },
      { kind: "veto", binding: { ...binding, ...changed }, reason: "stop" },
    ])
      expect(() => decodeHookResponse(response(decision), input, registration)).toThrow(
        "hook-decision-stale",
      );
  }
  expect(() =>
    decodeHookResponse(
      response({ kind: "observe" }),
      { ...input, contribution: { ...input.contribution, generation: 8 } },
      registration,
    ),
  ).toThrow("hook-registration-stale");
});

test("typed evaluator, async and terminal decisions cannot grant consent or change input", () => {
  const evaluator = hookRegistrationSchema.parse({
    ...externalHookFixture,
    nonlocalOptIn: true,
    handler: { kind: "prompt-evaluator-v1", bindingId: "model", instructions: "i.md" },
  });
  expect(
    decodeHookResponse(response({ kind: "veto", reason: "refused" }), input, evaluator).kind,
  ).toBe("veto");
  for (const handler of [evaluator, { ...registration, mode: "async" as const }]) {
    expect(decodeHookResponse(response({ kind: "observe" }), input, handler).kind).toBe("observe");
    for (const decision of [
      { kind: "transform", input: { account: "other", argv: ["other"] } },
      {
        kind: "external-effect-request",
        request: { kind: "confirmation", reason: "model agrees" },
      },
      { kind: "observe", permission: "granted" },
    ])
      expect(() => decodeHookResponse(response(decision), input, handler)).toThrow();
  }
  for (const extra of [
    { result: {} },
    { processing: {} },
    { permission: "allow" },
    { capabilityId: "other" },
  ])
    expect(() =>
      decodeHookResponse(response({ kind: "transform", ...extra }), input, registration),
    ).toThrow();
});

test("async post requests are separate proposals, never retroactive mutations", () => {
  const envelope = hookFixtureEnvelope("after-capability-invocation", {
    capabilityId: "tool",
    inputDigest: hookFixtureDigest,
    declaredEffect: "observation",
    terminal: "completed",
    effect: "completed",
  });
  const declared = hookRegistrationSchema.parse({
    ...externalHookFixture,
    point: envelope.point,
    mode: "async",
  });
  const bound = { ...input, envelope };
  expect(
    decodeHookResponse(
      response({
        kind: "external-effect-request",
        binding: hookDecisionBinding(envelope),
        request: { kind: "tool", name: "read_file", arguments: { path: "a" } },
      }),
      bound,
      declared,
    ).kind,
  ).toBe("external-effect-request");
  expect(() =>
    decodeHookResponse(
      response({ kind: "veto", binding: hookDecisionBinding(envelope), reason: "undo" }),
      bound,
      declared,
    ),
  ).toThrow();
});
