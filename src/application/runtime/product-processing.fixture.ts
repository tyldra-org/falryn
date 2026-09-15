/** Injected processing provider exercised through normal product composition; no network. */
import {
  configurationGeneration,
  createManualClock,
  instant,
  modelAttemptId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import type { ProcessingObservation } from "../../domain/sessions/model-processing.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import type { ModelPricing } from "../../providers/catalog/model-pricing.ts";
import { EMPTY_MODEL_PREFERENCES } from "../../providers/configuration/policy-schema.ts";
import type {
  ProcessingAuthority,
  ProcessingQualification,
} from "../../providers/configuration/processing.ts";
import {
  createDeterministicProviderAdapter,
  type ModelRequest,
  type ProviderAdapterPort,
  resolveModelRoute,
} from "../../providers/index.ts";
import type { NormalizedProviderEvent } from "../../providers/protocol/stream.ts";
import {
  createProductResources,
  type ProductTaskResources,
} from "../orchestration/product-resources.ts";
import { composeProductWorkspaceTools } from "../tools/product-tools-workspace.ts";
import { composeProductAgentRuntime } from "./product-agent-runtime.ts";
import { createProductLiveTurnExecutor, productModelPolicy } from "./product-live-turn.ts";

export function processingProduct(maxConcurrent = 1) {
  const clock = createManualClock(instant(100));
  const generation = configurationGeneration.from(5);
  const base = createDeterministicProviderAdapter({ script: { kind: "text", text: "done" } });
  const model = base.supportedModels[0];
  const capability = base.modelCapabilities?.[0];
  if (!model || !capability) throw new Error("Missing fixture model");
  const initialPlan = base.transportCompatibilityFor(model);
  if (!initialPlan) throw new Error("Missing fixture transport");
  const qualification: ProcessingQualification = {
    providerId: String(base.identity.providerId),
    destinationId: base.identity.destinationId,
    modelId: model,
    operation: "deterministic",
    transportVersion: "fixture-v1",
    evidenceUrl: "https://example.com/processing",
    checkedAt: "2026-09-12",
    modes: {
      "provider-default": {
        support: "supported",
        nativeParameters: null,
        priceTierIds: ["standard", "premium"],
      },
      standard: {
        support: "supported",
        nativeParameters: { serviceTier: "default", speed: null },
        priceTierIds: ["standard"],
      },
      fast: {
        support: "supported",
        nativeParameters: { serviceTier: "priority", speed: null },
        priceTierIds: ["premium", "standard"],
      },
    },
    actualTiers: [
      { nativeTier: "priority", mode: "fast" },
      { nativeTier: "default", mode: "standard" },
    ],
    cachePartitionByMode: false,
  };
  const pricing: ModelPricing = {
    kind: "published",
    billingMode: "api",
    currency: "USD",
    tokenUnit: 1_000_000,
    sourceUrl: "https://example.com/prices",
    observedAt: "2026-09-12",
    tiers: [1, 10].map((multiplier) => ({
      id: multiplier === 1 ? "standard" : "premium",
      label: "fixture",
      serviceTier: null,
      inputTokensFrom: 0,
      inputTokensThrough: null,
      effectiveFrom: null,
      effectiveUntil: null,
      utcWindows: [],
      usdMicrosPerMillionTokens: {
        input: multiplier * 1_000_000,
        cachedInput: multiplier * 2_000_000,
        cacheWriteInput: multiplier * 3_000_000,
        output: multiplier * 1_000_000,
      },
    })),
  };
  const authority: ProcessingAuthority = {
    accountGeneration: "account-1",
    adapterGeneration: "fixture-v1",
    authorized: true,
    capacity: "available",
  };
  const state = {
    authority,
    qualification,
    pricing,
    observations: [] as ProcessingObservation[],
    reportUsage: true,
    fail: false,
    quotaFailures: 0,
    processingModes: ["provider-default", "standard", "fast"] as const,
    beforeResponse: null as (() => Promise<void>) | null,
  };
  const requests: ModelRequest[] = [];
  const plan = {
    ...initialPlan,
    declaration: { ...initialPlan.declaration, processingQualifications: [qualification] },
  };
  const adapter: ProviderAdapterPort = {
    ...base,
    transportCompatibility: plan,
    processingTransportVersion: "fixture-v1",
    get processingModes() {
      return state.processingModes;
    },
    transportCompatibilityFor: () => plan,
    processingAuthority: () => state.authority,
    modelCapabilities: [{ ...capability, pricing, contextTokens: 10000, outputTokens: 10 }],
    async *stream(request): AsyncGenerator<NormalizedProviderEvent> {
      requests.push(request);
      if (state.beforeResponse) await state.beforeResponse();
      const spine = {
        requestId: request.requestId,
        modelAttemptId: modelAttemptId.from("processing-provider-attempt"),
      };
      let sequence = 1;
      yield { ...spine, sequence: sequence++, kind: "request-started" };
      if (state.quotaFailures > 0) {
        state.quotaFailures -= 1;
        yield {
          ...spine,
          sequence,
          kind: "error",
          failure: {
            kind: "rate-limit",
            retryable: true,
            retryAfterMs: 0,
            message: "fixture quota refusal before content",
          },
        };
        return;
      }
      for (const observation of state.observations)
        yield { ...spine, sequence: sequence++, kind: "processing", observation };
      yield { ...spine, sequence: sequence++, kind: "text-delta", text: "done" };
      if (state.reportUsage)
        yield {
          ...spine,
          sequence: sequence++,
          kind: "usage",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 5,
            outputTokens: 2,
            provenance: "provider-reported",
          },
        };
      if (state.fail)
        yield {
          ...spine,
          sequence,
          kind: "error",
          failure: { kind: "network", retryable: false, message: "fixture failure" },
        };
      else yield { ...spine, sequence, kind: "finished", finishReason: "stop" };
    },
  };
  const correlation = {
    workspaceId: workspaceId.from("processing-workspace"),
    sessionId: sessionId.from("processing-session"),
    traceId: traceId.from("processing-trace"),
    configurationGeneration: generation,
  };
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem: createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 0, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const resources = createProductResources(clock, { maxConcurrent });
  const eventStore = createInMemoryEventStore();
  const composed = composeProductAgentRuntime({
    clock,
    correlation,
    resources,
    eventStore,
    streamId: streamId.from("processing-stream"),
    providerAdapter: adapter,
    toolRegistry: tools.registry,
    toolRunner: tools.runner,
  });
  if (!composed.ok) throw new Error(composed.error.code);
  const runtime = composed.value;
  const preferences = {
    ...EMPTY_MODEL_PREFERENCES,
    roles: {
      default: {
        providerProfileId: adapter.identity.profileId,
        providerId: adapter.identity.providerId,
        modelId: model,
        reasoning: "provider-default" as const,
        budgets: {},
        fallbacks: [],
      },
    },
  };
  const executor = createProductLiveTurnExecutor({
    runtime,
    clock,
    modelPreferences: () => preferences,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  function select(mode: "standard" | "fast" | "provider-default") {
    const policy = productModelPolicy(
      adapter,
      {
        generation: 1,
        provenance: "static-config",
        fetchedAt: null,
        expiresAt: null,
        models: adapter.modelCapabilities ?? [],
      },
      undefined,
      undefined,
      preferences,
    );
    if (!policy) throw new Error("Missing policy");
    const selected = resolveModelRoute({
      policy,
      processing: { mode },
      catalogs: [
        {
          providerId: adapter.identity.providerId,
          profileId: adapter.identity.profileId,
          adapterKind: adapter.identity.adapterKind,
          destinationId: adapter.identity.destinationId,
          transportCompatibility: plan,
          requestInputModalities: adapter.requestInputModalities,
          catalog: {
            generation: 1,
            provenance: "static-config",
            fetchedAt: null,
            expiresAt: null,
            models: adapter.modelCapabilities ?? [],
          },
        },
      ],
    });
    if (selected.kind !== "selected") throw new Error(selected.kind);
    return selected;
  }
  async function attempt(
    id: string,
    mode: "standard" | "fast" | "provider-default",
    taskResources?: ProductTaskResources,
    signal = new AbortController().signal,
  ) {
    const turn = turnId.from(id);
    const hosted = await runtime.hostTurn({ ...correlation, turnId: turn });
    if (hosted.kind !== "hosted") throw new Error(hosted.kind);
    for (const command of ["begin-orienting", "begin-assembling-context"] as const) {
      const advanced = runtime.turnCoordinator.apply({
        turnId: turn,
        configurationGeneration: generation,
        command,
      });
      if (!advanced.ok) throw new Error(advanced.error.code);
    }
    const selected = select(mode);
    const runner = runtime.requireAttemptRunner();
    if (!runner.ok) throw new Error(runner.error.code);
    return runner.value.run({
      ...(taskResources === undefined ? {} : { taskResources }),
      signal,
      turnId: turn,
      configurationGeneration: generation,
      boundConfigurationGeneration: generation,
      identity: {
        attemptNumber: 1,
        modelAttemptId: modelAttemptId.from(id),
        fallbackPosition: 0,
        providerKey: String(adapter.identity.providerId),
        modelKey: String(model),
      },
      receipt: selected.receipt,
      resourceCapability: selected.capability,
      modelInput: {
        messages: [{ role: "user", parts: [{ kind: "text", text: "Reply." }] }],
        tools: [],
        output: { kind: "text" },
        budgets: { maxInputTokens: 100 },
        disclosure: {
          catalogGeneration: generation,
          toolNames: [],
          discoveryHandle: "fixture",
          families: [],
          tools: [],
          omitted: [],
          schemaBytes: 0,
          schemaTokensEstimated: 0,
        },
      },
    });
  }
  return {
    clock,
    select,
    attempt,
    executor,
    runtime,
    adapter,
    preferences,
    requests,
    state,
    resources,
    eventStore,
  };
}

export const reportedProcessing = (
  mode: "fast" | "standard",
  source: ProcessingObservation["source"] = "provider-final",
): ProcessingObservation => ({
  actualMode: mode,
  nativeTier: mode === "fast" ? "priority" : "default",
  source,
  observedAt: 100,
  downgradeReason: mode === "standard" ? "capacity" : null,
  usageAttribution: "request",
});
