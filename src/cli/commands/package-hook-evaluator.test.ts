import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import {
  EVALUATOR_FIXTURE_INSTRUCTIONS,
  evaluatorHookDeclaration,
} from "../../domain/extensions/hook-fixtures.ts";
import type { HookGrantRequirement } from "../../domain/extensions/hook-grants.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import type { DeterministicProviderScript, ModelRequest } from "../../providers/index.ts";
import { nativeProductJourney, observerNotices } from "../runtime/native-product-fixtures.ts";
import { preparePackageCliFixture } from "./package-health-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
const unavailable =
  process.platform === "win32" || createHostSandbox().probe().status !== "available";
const MODEL = {
  providerProfileId: "deterministic",
  providerId: "falryn-deterministic",
  modelId: "deterministic-echo",
};

type Journey = Awaited<ReturnType<typeof nativeProductJourney>>;
const recorded = (journey: Journey) =>
  journey.events?.ok
    ? journey.events.value.flatMap((event) =>
        event.kind === "history.recorded" ? [event.payload as Record<string, unknown>] : [],
      )
    : [];
const hookGates = (journey: Journey) =>
  recorded(journey).filter((entry) => entry.type === "gate" && entry.hook);
const answered = (journey: Journey) =>
  journey.requests.filter((request) => request.includes('\\"answer\\":42'));
const evaluations = (journey: Journey) =>
  journey.requests.flatMap((request) => {
    const parsed = JSON.parse(request) as ModelRequest;
    return parsed.output.kind === "json-schema" ? [parsed] : [];
  });
const verdict = (value: unknown): DeterministicProviderScript => ({
  kind: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
  usage: { inputTokens: 120, outputTokens: 12, provenance: "provider-reported" },
});

/** One headless run whose native tool is gated or observed by a package evaluator hook. */
async function journey(
  evaluate: ((request: ModelRequest, index: number) => DeterministicProviderScript) | null,
  options: {
    readonly declaration?: Parameters<typeof evaluatorHookDeclaration>[0];
    readonly grant?: (requirement: HookGrantRequirement) => unknown;
    readonly instructions?: string;
    /** Files placed in the session's workspace before the run. */
    readonly workspace?: Readonly<Record<string, string>>;
  } = {},
) {
  const root = await temporaryRoot("falryn-hook-evaluator-");
  await mkdir(join(root, "workspace"), { recursive: true });
  for (const [path, text] of Object.entries(options.workspace ?? {}))
    await writeFile(join(root, "workspace", path), text);
  const fixture = await prepareNativeCliFixture(
    "in-process",
    root,
    evaluate === null
      ? undefined
      : {
          declarations: [evaluatorHookDeclaration(options.declaration)],
          files: { "judge.md": options.instructions ?? EVALUATOR_FIXTURE_INSTRUCTIONS },
          grant: (requirement) =>
            (options.grant?.(requirement) ?? {
              contribution: requirement.contribution,
              binding: "binding" in requirement ? requirement.binding : "",
              model: MODEL,
            }) as never,
        },
  );
  const run = await nativeProductJourney(
    { home: root, environment: fixture.environment, name: fixture.name },
    evaluate === null ? {} : { evaluate },
  );
  return Object.assign(run, { workspace: join(root, "workspace") });
}

test.skipIf(unavailable)(
  "without an evaluator the tool gate spends no model work: control",
  async () => {
    const run = await journey(null);
    expect(run.result.payload?.stage).toBe("attempt-completed");
    expect(evaluations(run)).toEqual([]);
    expect(run.requests).toHaveLength(2);
    expect(answered(run)).toHaveLength(1);
  },
  90_000,
);

test.skipIf(unavailable)(
  "enabling lists the evaluator's binding and refuses a missing or different grant",
  async () => {
    const root = await temporaryRoot("falryn-hook-evaluator-grant-");
    const fixture = await preparePackageCliFixture("in-process", root, "healthy", true, {
      declarations: [evaluatorHookDeclaration()],
      files: { "judge.md": EVALUATOR_FIXTURE_INSTRUCTIONS },
    });
    const enable = (grants?: unknown) =>
      fixture.invoke(
        ["package", "enable"],
        {
          operationId: randomUUID(),
          packageId: "fixture",
          expectedRevision: 1,
          nativeActivation: {
            scope: "user",
            expectedRevision: 0,
            contributions: [fixture.contribution, ...fixture.extraContributions],
            ...(grants === undefined ? {} : { grants }),
          },
        },
        packageReceiptSchema,
      );
    const missing = await enable();
    expect(missing).toMatchObject({ status: "failed", code: "hook-grant-required" });
    const { requirements } = z
      .object({ requirements: z.array(z.custom<HookGrantRequirement>()) })
      .parse(missing.data);
    const [hook] = fixture.extraContributions;
    if (hook === undefined) throw new Error("missing hook contribution");
    // Installing or matching an event admits nothing: only this answer names a model.
    expect(requirements).toEqual([{ contribution: hook, binding: "judge" }]);
    expect(await enable([{ contribution: hook, binding: "other", model: MODEL }])).toMatchObject({
      code: "hook-grant-binding-mismatch",
    });
    expect(
      await enable([{ contribution: hook, url: "https://hooks.example.com/", credential: null }]),
    ).toMatchObject({ code: "hook-grant-binding-mismatch" });
    expect(
      await enable([
        { contribution: hook, binding: "judge", model: MODEL },
        { contribution: fixture.contribution, binding: "judge", model: MODEL },
      ]),
    ).toMatchObject({ code: "hook-grant-unexpected" });
    expect(await enable([{ contribution: hook, binding: "judge", model: MODEL }])).toMatchObject({
      status: "preview",
      code: "native-activation-confirmation-required",
      data: { requirements },
    });
  },
  60_000,
);

test.skipIf(unavailable).each([
  ["allow", false],
  ["deny", true],
] as const)(
  "a prompt evaluator gates a real native tool through the session's own provider: %s",
  async (answer, veto) => {
    const run = await journey(() => verdict({ verdict: answer, reason: "fixture verdict" }));
    // One structured request, with the package's instructions as trusted text and the
    // declared evidence as the only untrusted user content.
    const [request, ...extra] = evaluations(run);
    expect(extra).toEqual([]);
    expect(request?.tools).toEqual([]);
    const system = request?.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.parts.map((part) => (part.kind === "text" ? part.text : "")))
      .join("\n");
    expect(system).toContain(EVALUATOR_FIXTURE_INSTRUCTIONS);
    const user = request?.messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.parts.map((part) => (part.kind === "text" ? part.text : "")))
      .join("\n");
    expect(user).toContain('"point":"before-capability-invocation"');
    expect(system).not.toContain('"point":"before-capability-invocation"');
    expect(request?.budgets).toMatchObject({ maxInputTokens: 8_192, maxOutputTokens: 1_024 });
    const gates = hookGates(run).filter((gate) => gate.stage === "pre-hook");
    expect(gates.map((gate) => gate.decision)).toEqual([
      "hook-chain-bound",
      veto ? "veto" : "observe",
    ]);
    expect(run.result.payload?.stage).toBe(veto ? "attempt-failed" : "attempt-completed");
    // The subject ran exactly once on allow, never on deny.
    expect(answered(run)).toHaveLength(veto ? 0 : 1);
    // The settled receipt names the model and its reported usage; the actual served model
    // is unknown because providers do not report it.
    const settled = gates.at(-1)?.hook as
      | { failureEvidence?: { handlerFacts?: unknown; remediation?: string } }
      | undefined;
    expect(settled?.failureEvidence).toMatchObject({
      remediation: "none",
      handlerFacts: {
        kind: "model",
        status: "completed",
        response: "valid",
        requests: 1,
        reads: 0,
        inputTokens: 120,
        outputTokens: 12,
        requestedModel: MODEL.modelId,
        resolvedModel: MODEL.modelId,
        actualModel: null,
        effects: "observed",
      },
    });
  },
  90_000,
);

const failure = (run: Journey, code: string) =>
  hookGates(run).find((entry) => entry.decision === "failed:" + code)?.hook as
    | { failureEvidence?: { handlerFacts?: unknown } }
    | undefined;

test.skipIf(unavailable).each([
  // [name, answer, failure, evaluator requests, receipt facts]
  [
    "a prose allow",
    () => verdict("ALLOW - this looks safe"),
    "hook-evaluator-output-invalid",
    1,
    { status: "completed", response: "invalid", requests: 1, effects: "observed" },
  ],
  [
    "a fenced verdict",
    () => verdict('```json\n{"verdict":"allow","reason":"ok"}\n```'),
    "hook-evaluator-output-invalid",
    1,
    { response: "invalid" },
  ],
  [
    "a forged decision binding",
    () =>
      verdict({ verdict: "allow", reason: "ok", binding: { factId: "forged" }, kind: "observe" }),
    "hook-evaluator-output-invalid",
    1,
    { response: "invalid" },
  ],
  [
    "an allow hidden in the reason of a missing verdict",
    () => verdict({ reason: "verdict: allow" }),
    "hook-evaluator-output-invalid",
    1,
    { response: "invalid" },
  ],
  [
    "a truncated answer",
    () => ({ kind: "text", text: '{"verdict":"all', finishReason: "length" }) as const,
    "hook-evaluator-incomplete",
    1,
    { requests: 1, response: "missing" },
  ],
  [
    "an exhausted provider quota",
    () =>
      ({
        kind: "error",
        failureKind: "rate-limit",
        message: "quota exhausted",
        retryable: true,
      }) as const,
    "hook-evaluator-limit",
    1,
    { status: "failed", response: "missing" },
  ],
] as const)(
  "%s cannot authorize: the gate fails closed and the subject never runs",
  async (_name, answer, code, requests, facts) => {
    const run = await journey(answer as () => DeterministicProviderScript);
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(answered(run)).toEqual([]);
    // Nothing is retried or repaired.
    expect(evaluations(run)).toHaveLength(requests);
    const decisions = hookGates(run).map((gate) => gate.decision);
    expect(decisions).toContain("failed:" + code);
    expect(failure(run, code)?.failureEvidence?.handlerFacts).toMatchObject({
      kind: "model",
      ...facts,
    });
  },
  90_000,
);

test.skipIf(unavailable)(
  "an evaluator that outlives its deadline times out, settles its usage and is not replayed",
  async () => {
    const run = await journey(() => ({ kind: "abortable", hangUntilAbort: true }), {
      declaration: { timeoutMs: 1_000 },
    });
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(answered(run)).toEqual([]);
    expect(evaluations(run)).toHaveLength(1);
    expect(failure(run, "timed-out")?.failureEvidence?.handlerFacts).toMatchObject({
      kind: "model",
      requests: 1,
    });
  },
  90_000,
);

test.skipIf(unavailable).each([
  ["a model the provider does not offer", { ...MODEL, modelId: "not-offered" }],
  ["a profile the session cannot resolve", { ...MODEL, providerProfileId: "absent" }],
] as const)(
  "%s is unavailable before any request: no fallback to another model",
  async (_name, model) => {
    const run = await journey(() => verdict({ verdict: "allow", reason: "unused" }), {
      grant: (requirement) => ({
        contribution: requirement.contribution,
        binding: "judge",
        model,
      }),
    });
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(evaluations(run)).toEqual([]);
    expect(failure(run, "hook-model-unavailable")?.failureEvidence?.handlerFacts).toMatchObject({
      kind: "model",
      status: "not-started",
      requests: 0,
      effects: "none",
      resolvedModel: null,
    });
  },
  90_000,
);

test.skipIf(unavailable)(
  "an agent evaluator reads one authorized file through the gateway and settles its child",
  async () => {
    const run = await journey(
      (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              name: "read_file",
              toolCallId: "evaluator-read",
              argumentFragments: [JSON.stringify({ path: "policy.txt" })],
            }
          : verdict({ verdict: "allow", reason: "policy permits it" }),
      { declaration: { agent: true }, workspace: { "policy.txt": "EVALUATOR-POLICY-TEXT" } },
    );
    expect(run.result.payload?.stage).toBe("attempt-completed");
    expect(answered(run)).toHaveLength(1);
    const [first, second, ...extra] = evaluations(run);
    expect(extra).toEqual([]);
    // Only the declared read tool was offered, and its result reached the second request.
    expect(first?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(JSON.stringify(second?.messages)).toContain("EVALUATOR-POLICY-TEXT");
    expect(
      hookGates(run)
        .filter((gate) => gate.stage === "pre-hook")
        .map((gate) => gate.decision),
    ).toEqual(["hook-chain-bound", "observe"]);
  },
  90_000,
);

test.skipIf(unavailable)(
  "an agent evaluator cannot write: a tool outside its read-only subset is refused",
  async () => {
    const run = await journey(
      (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              name: "write_files",
              toolCallId: "evaluator-write",
              argumentFragments: [
                JSON.stringify({ files: [{ path: "owned.txt", content: "EVALUATOR-WROTE" }] }),
              ],
            }
          : verdict({ verdict: "allow", reason: "done" }),
      { declaration: { agent: true } },
    );
    expect(evaluations(run)[0]?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(await Bun.file(join(run.workspace, "owned.txt")).exists()).toBe(false);
    // The suggestion never reached a runner, and the evaluation it spoiled fails closed.
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(answered(run)).toEqual([]);
    expect(
      failure(run, "hook-evaluator-tool-refused")?.failureEvidence?.handlerFacts,
    ).toMatchObject({ kind: "model", requests: 1, reads: 0 });
  },
  90_000,
);

test.skipIf(unavailable)(
  "an agent evaluator declaring a writing tool never starts",
  async () => {
    const run = await journey(() => verdict({ verdict: "allow", reason: "unused" }), {
      declaration: { agent: true, readTools: ["write_files"] },
    });
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(evaluations(run)).toEqual([]);
    expect(
      failure(run, "hook-evaluator-tool-refused")?.failureEvidence?.handlerFacts,
    ).toMatchObject({ kind: "model", status: "not-started", requests: 0 });
  },
  90_000,
);

test.skipIf(unavailable)(
  "an agent evaluator that keeps reading exhausts its request limit",
  async () => {
    const run = await journey(
      (_request, index) => ({
        kind: "tool",
        name: "read_file",
        toolCallId: "evaluator-read-" + index,
        argumentFragments: [JSON.stringify({ path: "policy.txt" })],
      }),
      { declaration: { agent: true }, workspace: { "policy.txt": "again" } },
    );
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(answered(run)).toEqual([]);
    expect(evaluations(run)).toHaveLength(4);
    expect(failure(run, "hook-evaluator-limit")?.failureEvidence?.handlerFacts).toMatchObject({
      kind: "model",
      requests: 4,
      reads: 4,
    });
  },
  90_000,
);

test.skipIf(unavailable)(
  "an async evaluator observes after the subject settles and leaves one notice",
  async () => {
    const run = await journey(() => verdict({ verdict: "deny", reason: "would not have" }), {
      declaration: { point: "after-capability-invocation", mode: "async" },
    });
    // A negative verdict from an observer blocks nothing.
    expect(run.result.payload?.stage).toBe("attempt-completed");
    expect(answered(run)).toHaveLength(1);
    expect(evaluations(run)).toHaveLength(1);
    expect(
      hookGates(run)
        .filter((gate) => gate.stage === "post-hook")
        .map((gate) => gate.decision),
    ).toEqual(["hook-chain-bound", "queued", "observe"]);
    expect(observerNotices(run)).toHaveLength(1);
  },
  90_000,
);
