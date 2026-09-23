/** Scripted, clock-paced provider streams through normal product composition; no network. */
import {
  type ClockPort,
  configurationGeneration,
  createManualClock,
  duration,
  instant,
  type ManualClock,
  modelAttemptId,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { EMPTY_MODEL_PREFERENCES } from "../../providers/configuration/policy-schema.ts";
import {
  createDeterministicProviderAdapter,
  type ProviderAdapterPort,
  type UsageUnits,
} from "../../providers/index.ts";
import type {
  NormalizedProviderEvent,
  ProviderEventSpine,
} from "../../providers/protocol/stream.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { composeProductWorkspaceTools } from "../tools/product-tools-workspace.ts";
import { composeProductAgentRuntime } from "./product-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "./product-live-turn.ts";
import type { ToolRunnerPort } from "./tool-call-loop.ts";

type Emit = Omit<ProviderEventSpine, "sequence">;

/** One provider request's events. `clock` paces deltas; `signal` is the request's. */
export type GenerationScript = (
  spine: Emit,
  clock: ManualClock,
  signal: AbortSignal,
) => AsyncGenerator<Omit<NormalizedProviderEvent, "sequence" | keyof Emit>>;

/** Text deltas at a fixed spacing after a time-to-first-token delay. */
export function timedText(options: {
  readonly fragments: readonly string[];
  readonly firstAfterMs: number;
  readonly everyMs: number;
  readonly terminalAfterMs?: number;
  readonly usage?: UsageUnits;
}): GenerationScript {
  return async function* (_spine, clock) {
    for (const [index, fragment] of options.fragments.entries()) {
      await clock.advance(duration(index === 0 ? options.firstAfterMs : options.everyMs));
      yield { kind: "text-delta", text: fragment };
    }
    await clock.advance(duration(options.terminalAfterMs ?? options.everyMs));
    if (options.usage) yield { kind: "usage", usage: options.usage };
    yield { kind: "finished", finishReason: "stop" };
  };
}

/** Explanatory text followed by one tool proposal. */
export function textThenTool(options: {
  readonly text: string;
  readonly firstAfterMs: number;
  readonly proposalAfterMs: number;
  readonly name: string;
  readonly argumentsJson: string;
}): GenerationScript {
  return async function* (_spine, clock) {
    await clock.advance(duration(options.firstAfterMs));
    yield { kind: "text-delta", text: options.text };
    await clock.advance(duration(options.proposalAfterMs));
    yield {
      kind: "tool-proposal",
      toolCallId: "call-generation-1",
      name: options.name,
      argumentsJson: options.argumentsJson,
    };
    yield { kind: "finished", finishReason: "tool-calls" };
  };
}

export function generationProduct(
  options: {
    readonly clock?: ManualClock;
    readonly name?: string;
    readonly maxConcurrent?: number;
    /** Held inside tool execution, between provider streams. */
    readonly toolMs?: number;
    /** Held inside the focused confirmation, between provider streams. */
    readonly confirmationMs?: number;
  } = {},
) {
  const clock = options.clock ?? createManualClock(instant(1_000));
  const name = options.name ?? "generation";
  const generation = configurationGeneration.from(3);
  const base = createDeterministicProviderAdapter({ script: { kind: "text", text: "unused" } });
  const model = base.supportedModels[0];
  if (!model) throw new Error("Missing fixture model");
  const state = {
    scripts: [] as GenerationScript[],
    fallback: timedText({ fragments: ["done"], firstAfterMs: 10, everyMs: 10 }),
    streams: 0,
    confirmations: 0,
    toolRuns: 0,
  };
  const adapter: ProviderAdapterPort = {
    ...base,
    async *stream(request, context): AsyncGenerator<NormalizedProviderEvent> {
      state.streams += 1;
      const spine = {
        requestId: request.requestId,
        modelAttemptId: modelAttemptId.from(`${name}-provider`),
      };
      let sequence = 1;
      yield { ...spine, sequence: sequence++, kind: "request-started" };
      const script = state.scripts.shift() ?? state.fallback;
      for await (const event of script(spine, clock, context.signal)) {
        yield { ...spine, sequence: sequence++, ...event } as NormalizedProviderEvent;
      }
    },
  };
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem: createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 0, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const runner: ToolRunnerPort = {
    ...tools.runner,
    async execute(request) {
      state.toolRuns += 1;
      if (options.toolMs) await clock.advance(duration(options.toolMs));
      return tools.runner.execute(request);
    },
  };
  const correlation = {
    workspaceId: workspaceId.from(`${name}-workspace`),
    sessionId: sessionId.from(`${name}-session`),
    traceId: traceId.from(`${name}-trace`),
    configurationGeneration: generation,
  };
  const composed = composeProductAgentRuntime({
    clock,
    correlation,
    resources: createProductResources(clock, { maxConcurrent: options.maxConcurrent ?? 2 }),
    eventStore: createInMemoryEventStore(),
    streamId: streamId.from(`${name}-stream`),
    providerAdapter: adapter,
    toolRegistry: tools.registry,
    toolRunner: runner,
    toolConfirmation: {
      async resolve(request) {
        state.confirmations += 1;
        if (options.confirmationMs) await clock.advance(duration(options.confirmationMs));
        return { kind: "confirmed", confirmationId: request.confirmationId };
      },
    },
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
    clock: clock as ClockPort,
    modelPreferences: () => preferences,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  return { clock, state, runtime, executor };
}
