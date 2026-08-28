import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createManualClock,
  createStubCommandRunner,
  DEFAULT_BRIEF_NEED,
  instant,
  localPath,
  modelAttemptId,
  projectBrief,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createHostProcessCapturePort } from "../integrations/index.ts";
import {
  createDeterministicProviderAdapter,
  type ModelRequest,
  type RoutingReceipt,
} from "../providers/index.ts";
import { composeProductAgentRuntime } from "./product-agent-runtime.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { composeProductProcessTools } from "./product-tools-process.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

const generation = configurationGeneration.from(5);

function setup(
  adapter = createDeterministicProviderAdapter({
    script: { kind: "abortable", hangUntilAbort: true },
  }),
) {
  const correlation = {
    workspaceId: workspaceId.from("workspace-attempt-product"),
    sessionId: sessionId.from("session-attempt-product"),
    traceId: traceId.from("trace-attempt-product"),
    configurationGeneration: generation,
  };
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem: createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const runtime = composeProductAgentRuntime({
    eventStore: createInMemoryEventStore(),
    clock: createManualClock(instant(100)),
    streamId: streamId.from("session:attempt-product"),
    correlation,
    providerAdapter: adapter,
    toolRegistry: tools.registry,
    toolRunner: tools.runner,
  });
  if (!runtime.ok) {
    throw new Error(runtime.error.code);
  }
  const disclosure = discloseProductTools(tools.registry);
  return { adapter, correlation, runtime: runtime.value, disclosure };
}

function receipt(
  setupResult: ReturnType<typeof setup>,
  budgets: RoutingReceipt["budgets"] = {},
): RoutingReceipt {
  const model = setupResult.adapter.supportedModels[0];
  if (model === undefined) {
    throw new Error("deterministic provider has no model");
  }
  return {
    role: "default",
    intent: "coding",
    selectionReason: "intent-mapped-role",
    requiredCapabilities: { tools: true, streaming: true },
    providerId: setupResult.adapter.identity.providerId,
    modelId: model,
    reasoning: "provider-default",
    fallbackPosition: 0,
    budgets,
    catalogGeneration: 1,
    modelCapabilitySchemaVersion: 1,
    catalogProvenance: "static-config",
    recordedAt: null,
  };
}

async function start(setupResult: ReturnType<typeof setup>, id: string) {
  const turn = turnId.from(id);
  const hosted = await setupResult.runtime.hostTurn({
    turnId: turn,
    sessionId: setupResult.correlation.sessionId,
    workspaceId: setupResult.correlation.workspaceId,
    traceId: setupResult.correlation.traceId,
    configurationGeneration: generation,
  });
  if (hosted.kind !== "hosted") {
    throw new Error(hosted.kind);
  }
  for (const command of ["begin-orienting", "begin-assembling-context"] as const) {
    const advanced = setupResult.runtime.turnCoordinator.apply({
      turnId: turn,
      command,
      configurationGeneration: generation,
    });
    if (!advanced.ok) {
      throw new Error(advanced.error.code);
    }
  }
  return turn;
}

function disclosureInput(product: ReturnType<typeof setup>) {
  return {
    catalogGeneration: product.disclosure.receipt.catalogGeneration,
    toolNames: product.disclosure.receipt.disclosed.map((tool) => tool.name),
    discoveryHandle: product.disclosure.receipt.discoveryHandle,
    families: product.disclosure.receipt.families,
    tools: product.disclosure.receipt.disclosed.map((tool) => ({
      name: tool.name,
      capabilityId: tool.capabilityId,
      version: tool.version,
      schemaDigest: tool.schemaDigest,
      schemaBytes: tool.schemaBytes,
      schemaTokensEstimated: tool.schemaTokensEstimated,
    })),
    omitted: product.disclosure.receipt.omitted,
    schemaBytes: product.disclosure.receipt.schemaBytes,
    schemaTokensEstimated: product.disclosure.receipt.schemaTokensEstimated,
  };
}

describe("createProductAttemptRunner", () => {
  test("classifies its own wall-time deadline as timed-out", async () => {
    const product = setup();
    const turn = await start(product, "turn-attempt-timeout");
    const runner = product.runtime.requireAttemptRunner();
    if (!runner.ok) {
      throw new Error(runner.error.code);
    }

    const result = await runner.value.run({
      turnId: turn,
      identity: {
        attemptNumber: 1,
        modelAttemptId: modelAttemptId.from("attempt-timeout"),
        fallbackPosition: 0,
        providerKey: product.adapter.identity.providerId,
        modelKey: String(product.adapter.supportedModels[0]),
      },
      receipt: receipt(product),
      boundConfigurationGeneration: generation,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      modelInput: {
        messages: [{ role: "user", parts: [{ kind: "text", text: "wait" }] }],
        tools: product.disclosure.modelTools,
        output: { kind: "text" },
        budgets: { wallTimeMs: 5 },
        disclosure: disclosureInput(product),
      },
    });

    expect(result.fact).toEqual({ kind: "timed-out", effect: "none", retryable: true });
    expect(result.turn?.status).toBe("terminal");
    if (result.turn?.status === "terminal") {
      expect(result.turn.outcome).toEqual({ kind: "timed-out", effect: "none" });
    }
  });

  test("rejects a stale disclosure before contacting the provider", async () => {
    let providerRequests = 0;
    const product = setup(
      createDeterministicProviderAdapter({
        onRequest: () => {
          providerRequests += 1;
        },
      }),
    );
    const turn = await start(product, "turn-attempt-stale");
    const runner = product.runtime.requireAttemptRunner();
    if (!runner.ok) {
      throw new Error(runner.error.code);
    }

    const result = await runner.value.run({
      turnId: turn,
      identity: {
        attemptNumber: 1,
        modelAttemptId: modelAttemptId.from("attempt-stale"),
        fallbackPosition: 0,
        providerKey: product.adapter.identity.providerId,
        modelKey: String(product.adapter.supportedModels[0]),
      },
      receipt: receipt(product),
      boundConfigurationGeneration: generation,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      modelInput: {
        messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
        tools: product.disclosure.modelTools,
        output: { kind: "text" },
        budgets: {},
        disclosure: {
          ...disclosureInput(product),
          catalogGeneration: configurationGeneration.from(6),
        },
      },
    });

    expect(result.fact).toMatchObject({
      kind: "failed",
      category: "invalid-request",
      retryable: false,
      effect: "none",
    });
    expect(providerRequests).toBe(0);
  });

  test("rejects a provider tool schema that does not match the disclosure receipt", async () => {
    let providerRequests = 0;
    const product = setup(
      createDeterministicProviderAdapter({
        onRequest: () => {
          providerRequests += 1;
        },
      }),
    );
    const turn = await start(product, "turn-attempt-schema-mismatch");
    const runner = product.runtime.requireAttemptRunner();
    if (!runner.ok) {
      throw new Error(runner.error.code);
    }
    const first = product.disclosure.modelTools[0];
    if (first === undefined) {
      throw new Error("expected a disclosed tool");
    }

    const result = await runner.value.run({
      turnId: turn,
      identity: {
        attemptNumber: 1,
        modelAttemptId: modelAttemptId.from("attempt-schema-mismatch"),
        fallbackPosition: 0,
        providerKey: product.adapter.identity.providerId,
        modelKey: String(product.adapter.supportedModels[0]),
      },
      receipt: receipt(product),
      boundConfigurationGeneration: generation,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      modelInput: {
        messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
        tools: [
          { ...first, parameters: { type: "object", additionalProperties: true } },
          ...product.disclosure.modelTools.slice(1),
        ],
        output: { kind: "text" },
        budgets: {},
        disclosure: disclosureInput(product),
      },
    });

    expect(result.fact).toMatchObject({
      kind: "failed",
      category: "invalid-request",
      retryable: false,
      effect: "none",
    });
    expect(providerRequests).toBe(0);
  });

  test("continues a real raw process call with one bounded non-duplicated result", async () => {
    const requests: ModelRequest[] = [];
    const adapter = createDeterministicProviderAdapter({
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "call-raw-process",
              name: "run_shell",
              argumentFragments: [
                '{"command":"printf \'first\\nsecond api_key=hunter2\\n\'","outputMode":"raw"}',
              ],
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
                provenance: "provider-reported",
              },
            }
          : {
              kind: "text",
              text: "done",
              usage: {
                inputTokens: 8,
                outputTokens: 3,
                totalTokens: 11,
                provenance: "provider-reported",
              },
            },
      onRequest: (request) => requests.push(request),
    });
    const correlation = {
      workspaceId: workspaceId.from("workspace-attempt-process"),
      sessionId: sessionId.from("session-attempt-process"),
      traceId: traceId.from("trace-attempt-process"),
      configurationGeneration: generation,
    };
    const tools = composeProductProcessTools({
      generation,
      capture: createHostProcessCapturePort(),
      workspaceCwd: process.cwd(),
    });
    const runtime = composeProductAgentRuntime({
      eventStore: createInMemoryEventStore(),
      clock: createManualClock(instant(100)),
      streamId: streamId.from("session:attempt-process"),
      correlation,
      providerAdapter: adapter,
      toolRegistry: tools.registry,
      toolRunner: tools.runner,
      toolConfirmation: {
        resolve: async (request) => ({
          kind: "confirmed",
          confirmationId: request.confirmationId,
        }),
      },
    });
    if (!runtime.ok) {
      throw new Error(runtime.error.code);
    }
    const disclosure = discloseProductTools(tools.registry);
    const targetTurn = turnId.from("turn-attempt-process");
    const hosted = await runtime.value.hostTurn({
      turnId: targetTurn,
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: generation,
    });
    if (hosted.kind !== "hosted") {
      throw new Error(hosted.kind);
    }
    for (const command of ["begin-orienting", "begin-assembling-context"] as const) {
      const advanced = runtime.value.turnCoordinator.apply({
        turnId: targetTurn,
        command,
        configurationGeneration: generation,
      });
      if (!advanced.ok) {
        throw new Error(advanced.error.code);
      }
    }
    const runner = runtime.value.requireAttemptRunner();
    if (!runner.ok) {
      throw new Error(runner.error.code);
    }
    const model = adapter.supportedModels[0];
    if (model === undefined) {
      throw new Error("missing deterministic model");
    }
    const briefRequest = {
      turnId: targetTurn,
      sessionId: correlation.sessionId,
      configurationGeneration: generation,
      need: DEFAULT_BRIEF_NEED,
      policy: { verbosity: "compact" as const, source: "user" as const },
    };
    const briefProjection = projectBrief(briefRequest);
    if (!briefProjection.ok) {
      throw new Error(briefProjection.error.code);
    }
    const result = await runner.value.run({
      turnId: targetTurn,
      identity: {
        attemptNumber: 1,
        modelAttemptId: modelAttemptId.from("attempt-process"),
        fallbackPosition: 0,
        providerKey: adapter.identity.providerId,
        modelKey: String(model),
      },
      receipt: {
        role: "default",
        intent: "coding",
        selectionReason: "intent-mapped-role",
        requiredCapabilities: { tools: true, streaming: true },
        providerId: adapter.identity.providerId,
        modelId: model,
        reasoning: "provider-default",
        fallbackPosition: 0,
        budgets: {},
        catalogGeneration: 1,
        modelCapabilitySchemaVersion: 1,
        catalogProvenance: "static-config",
        recordedAt: null,
      },
      boundConfigurationGeneration: generation,
      configurationGeneration: generation,
      signal: new AbortController().signal,
      modelInput: {
        messages: [
          {
            role: "system",
            parts: [
              {
                kind: "text",
                text: `[brief source=brief:user]\n${briefProjection.value.guidance}`,
              },
            ],
          },
          { role: "user", parts: [{ kind: "text", text: "say hello" }] },
        ],
        tools: disclosure.modelTools,
        output: { kind: "text" },
        budgets: { maxOutputTokens: briefProjection.value.receipt.outputTokenBudget },
        brief: {
          request: briefRequest,
          receipt: briefProjection.value.receipt,
          sectionSource: "brief:user",
        },
        disclosure: {
          catalogGeneration: disclosure.receipt.catalogGeneration,
          toolNames: disclosure.receipt.disclosed.map((tool) => tool.name),
          discoveryHandle: disclosure.receipt.discoveryHandle,
          families: disclosure.receipt.families,
          tools: disclosure.receipt.disclosed.map((tool) => ({
            name: tool.name,
            capabilityId: tool.capabilityId,
            version: tool.version,
            schemaDigest: tool.schemaDigest,
            schemaBytes: tool.schemaBytes,
            schemaTokensEstimated: tool.schemaTokensEstimated,
          })),
          omitted: disclosure.receipt.omitted,
          schemaBytes: disclosure.receipt.schemaBytes,
          schemaTokensEstimated: disclosure.receipt.schemaTokensEstimated,
        },
      },
    });

    expect(result.fact.kind).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.metadata).toMatchObject({
      providerCatalogGeneration: 1,
      modelCapabilitySchemaVersion: 1,
    });
    expect(requests[1]?.messages[0]?.parts[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Keep risk warnings visible"),
    });
    expect(requests[1]?.budgets.maxOutputTokens).toBe(2_048);
    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    const toolPart = toolMessage?.parts[0];
    if (toolPart?.kind !== "text") {
      throw new Error("missing provider continuation tool result");
    }
    const continuation = JSON.parse(toolPart.text) as {
      output: {
        value: {
          owner: string;
          outputMode: string;
          stdout: { text: string };
          projection: { kind: string };
        };
      };
    };
    expect(continuation.output.value).toMatchObject({
      owner: "#796",
      outputMode: "raw",
      stdout: { text: "first\nsecond api_key=[redacted]\n" },
      projection: { kind: "raw", ordering: "per-stream" },
    });
    expect(JSON.stringify(continuation.output.value)).not.toContain("hunter2");
    expect(JSON.stringify(continuation.output.value).match(/first/g)).toHaveLength(1);
    expect("hush" in continuation.output.value).toBe(false);
    expect("capture" in continuation.output.value).toBe(false);
    expect(result.output).toMatchObject({
      providerRequests: 2,
      usage: {
        inputTokens: 18,
        outputTokens: 5,
        totalTokens: 23,
        provenance: "provider-reported",
      },
      briefReceipt: {
        selectedVerbosity: "compact",
        preservedFacts: ["risk"],
        outputTokenBudget: 2_048,
      },
    });
    expect(tools.catalog.resolve("run_shell")?.id).toBe(
      capabilityId.from("builtin:workspace/run_shell@1"),
    );
  });
});
