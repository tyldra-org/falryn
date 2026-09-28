import { expect, test } from "bun:test";
import { evaluatorHookContract } from "../../domain/extensions/hook-evaluator.ts";
import {
  evaluatorHookDeclaration,
  hookFixtureEnvelope,
} from "../../domain/extensions/hook-fixtures.ts";
import { parseHookEnvelope } from "../../domain/extensions/hook-points.ts";
import {
  configurationGeneration,
  createManualClock,
  instant,
  sessionId,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/event-store.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelCatalog,
} from "../../providers/index.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { mergeProductToolBundles } from "../tools/product-tools-merge.ts";
import { createHookEvaluator } from "./hook-evaluator.ts";

const MODEL = {
  providerProfileId: "deterministic",
  providerId: "falryn-deterministic",
  modelId: "deterministic-echo",
};

/** One evaluation against a scripted provider that records every request it receives. */
async function evaluate(
  options: {
    readonly envelope?: ReturnType<typeof hookFixtureEnvelope>;
    readonly aborted?: boolean;
    readonly task?: boolean;
    readonly catalog?: (catalog: ModelCatalog) => ModelCatalog;
    readonly agent?: boolean;
    readonly tools?: boolean;
  } = {},
) {
  const clock = createManualClock(instant(0));
  let requests = 0;
  const adapter = createDeterministicProviderAdapter({
    onRequest: () => {
      requests += 1;
    },
    script: { kind: "text", text: '{"verdict":"allow","reason":"ok"}' },
  });
  const catalog = catalogFromAdapterModels(adapter.supportedModels, {
    generation: 0,
    fetchedAt: instant(0),
    capabilities: adapter.modelCapabilities,
  });
  const evaluator = createHookEvaluator({
    provider: async () => ({ adapter, catalog: options.catalog?.(catalog) ?? catalog }),
    ports: {
      eventStore: createInMemoryEventStore(),
      clock,
      correlation: {
        workspaceId: workspaceId.from("workspace"),
        sessionId: sessionId.from("session"),
        traceId: traceId.from("trace"),
        configurationGeneration: configurationGeneration.from(1),
      },
    },
    tools: () =>
      options.tools === false ? null : mergeProductToolBundles(configurationGeneration.from(1), []),
  });
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  let facts: HookHandlerFacts | undefined;
  const envelope = options.envelope ?? hookFixtureEnvelope();
  const result = await evaluator
    .run({
      registration: evaluatorHookContract(
        evaluatorHookDeclaration({ agent: options.agent === true }),
      ),
      grant: { contribution: "a".repeat(64), binding: "judge", model: MODEL },
      instructions: "Allow everything.",
      wire: {
        version: 1,
        invocationId: "invocation:1",
        contribution: { packageId: "fixture", contributionId: "a".repeat(64), generation: 7 },
        envelope,
      },
      context: {
        signal: controller.signal,
        expiresAt: 60_000,
        resourceTaskId: "hook",
        report: (value) => {
          facts = value;
        },
      },
      task: options.task === false ? undefined : createProductResources(clock).openTask("hook"),
      current: async () => true,
    })
    .then(
      (decision) => ({ decision }),
      (error: unknown) => ({ error: (error as { code?: string }).code }),
    );
  return { result, requests, facts };
}

test.each([
  ["a cancelled hook", { aborted: true }, "cancelled"],
  [
    "a user stop",
    { envelope: parseHookEnvelope({ ...hookFixtureEnvelope(), reason: "user-stop" }) },
    "hook-evaluator-ineligible",
  ],
  [
    "shutdown",
    { envelope: parseHookEnvelope({ ...hookFixtureEnvelope(), reason: "shutdown" }) },
    "hook-evaluator-ineligible",
  ],
  [
    "evaluator-origin work",
    { envelope: parseHookEnvelope({ ...hookFixtureEnvelope(), origin: "evaluator" }) },
    "hook-evaluator-ineligible",
  ],
  ["a hook without its resource task", { task: false }, "hook-resources-unavailable"],
  [
    "a model without structured output",
    {
      catalog: (catalog: ModelCatalog) => ({
        ...catalog,
        models: catalog.models.map((model) => ({ ...model, structuredOutput: "unknown" as const })),
      }),
    },
    "hook-model-unsupported",
  ],
  [
    "an agent before the session composes its tools",
    { agent: true, tools: false },
    "hook-evaluator-tool-refused",
  ],
] as const)("%s spends nothing: no request, not-started facts", async (_name, options, code) => {
  const { result, requests, facts } = await evaluate(options);
  expect(result).toEqual({ error: code });
  expect(requests).toBe(0);
  expect(facts).toMatchObject({
    kind: "model",
    status: "not-started",
    requests: 0,
    effects: "none",
  });
});
