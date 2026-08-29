/**
 * Production provider/tool continuation controller (#786).
 *
 * One attempt owns one immutable provider route and disclosure generation.
 * Provider adapters only stream normalized events; every proposed capability
 * enters the registry-backed product gateway before its bounded result is
 * returned on the same conversation lineage.
 */

import {
  type AttemptFact,
  assertNever,
  type ClockPort,
  type EffectCertainty,
  type EffectiveExecutionPolicy,
  foldToolEffects,
  resolveExecutionProfile,
  type SessionCorrelation,
  type ToolHookRegistry,
  type ToolInvocationRecord,
  type ToolPolicyProfile,
  type ToolRegistry,
} from "../domain/index.ts";
import {
  type ModelAssistantToolCall,
  type ModelBudgets,
  type ModelMessage,
  type ModelRequest,
  modelRequestId,
  type ProviderAdapterPort,
  type UsageUnits,
} from "../providers/index.ts";
import { createBriefComposer } from "./brief.ts";
import { briefNeedAfterToolResults } from "./product-brief.ts";
import { measureProductToolSchema } from "./product-tool-disclosure.ts";
import {
  createProductToolGateway,
  type ProductToolConfirmationPort,
} from "./product-tool-gateway.ts";
import { promptCacheStablePrefixDigest } from "./provider-prompt-cache.ts";
import {
  createProviderStreamConsumer,
  type ProviderStreamConsumeOutcome,
} from "./provider-stream-consumer.ts";
import {
  createToolCallLoop,
  type ToolCallLoopOutcome,
  type ToolRunnerPort,
} from "./tool-call-loop.ts";
import {
  type AttemptModelInput,
  type AttemptRunnerPort,
  type AttemptRunnerRequest,
  type AttemptRunnerResult,
  attemptFactFromProviderFailure,
} from "./turn-attempt-policy.ts";
import type { TurnCoordinator } from "./turn-coordinator.ts";
import type { TurnEventJournalPort } from "./turn-event-journal.ts";

export type ProductAttemptRunnerOptions = {
  readonly clock: ClockPort;
  readonly coordinator: TurnCoordinator;
  readonly provider: ProviderAdapterPort;
  readonly registry: ToolRegistry;
  readonly toolRunner: ToolRunnerPort;
  readonly hooks: ToolHookRegistry;
  readonly journal: TurnEventJournalPort;
  readonly correlation: SessionCorrelation;
  readonly policy?: ToolPolicyProfile;
  readonly confirmation?: ProductToolConfirmationPort;
};

type AttemptDeadline = {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
};

function minBudget(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function effectiveBudgets(request: AttemptRunnerRequest): ModelBudgets {
  const input = request.modelInput?.budgets ?? {};
  return {
    ...(minBudget(input.maxInputTokens, request.receipt.budgets.inputTokens) === undefined
      ? {}
      : { maxInputTokens: minBudget(input.maxInputTokens, request.receipt.budgets.inputTokens) }),
    ...(minBudget(input.maxOutputTokens, request.receipt.budgets.outputTokens) === undefined
      ? {}
      : {
          maxOutputTokens: minBudget(input.maxOutputTokens, request.receipt.budgets.outputTokens),
        }),
    ...(minBudget(input.wallTimeMs, request.receipt.budgets.wallTimeMs) === undefined
      ? {}
      : { wallTimeMs: minBudget(input.wallTimeMs, request.receipt.budgets.wallTimeMs) }),
  };
}

function attemptDeadline(signal: AbortSignal, wallTimeMs: number | undefined): AttemptDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  const timer =
    wallTimeMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, wallTimeMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function assistantToolMessage(
  text: string,
  proposals: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[],
): ModelMessage {
  const toolCalls: ModelAssistantToolCall[] = proposals.map((proposal) => ({
    toolCallId: proposal.toolCallId,
    name: proposal.name,
    arguments: proposal.arguments,
  }));
  return {
    role: "assistant",
    parts: [{ kind: "text", text }],
    toolCalls,
  };
}

function toolResultMessage(record: ToolInvocationRecord): ModelMessage {
  return {
    role: "tool",
    toolCallId: record.toolCallId,
    parts: [{ kind: "text", text: JSON.stringify(record.outcome) }],
  };
}

function observed(snapshot: { readonly text: string; readonly reasoning: string }): boolean {
  return snapshot.text.length > 0 || snapshot.reasoning.length > 0;
}

function effectFromTurn(outcome: ProviderStreamConsumeOutcome): EffectCertainty {
  const turn = outcome.turn;
  return turn?.status === "terminal" && turn.outcome !== null
    ? turn.outcome.kind === "uncertain"
      ? "uncertain"
      : "effect" in turn.outcome
        ? turn.outcome.effect
        : "none"
    : outcome.snapshot !== null && observed(outcome.snapshot)
      ? "partial"
      : "none";
}

function factFromStream(outcome: ProviderStreamConsumeOutcome): AttemptFact {
  switch (outcome.kind) {
    case "finished":
      return {
        kind: "completed",
        finishReason: outcome.finishReason,
        observedContent: observed(outcome.snapshot),
        emittedToolProposal: outcome.toolProposals.length > 0,
      };
    case "failed":
    case "malformed":
      return attemptFactFromProviderFailure(outcome.failure, {
        effect: effectFromTurn(outcome),
        observedContent: observed(outcome.snapshot),
        emittedToolProposal: outcome.snapshot.toolProposals.length > 0,
      });
    case "cancelled":
      return { kind: "cancelled", effect: outcome.effect };
    case "timed-out":
      return { kind: "timed-out", effect: outcome.effect, retryable: true };
    case "partial":
      return {
        kind: "partial",
        reason: outcome.reason,
        effect: effectFromTurn(outcome),
        observedContent: observed(outcome.snapshot),
        emittedToolProposal: outcome.snapshot.toolProposals.length > 0,
      };
    case "backpressure-rejected":
      return {
        kind: "failed",
        category: "other",
        retryable: false,
        effect: effectFromTurn(outcome),
        observedContent: observed(outcome.snapshot),
        emittedToolProposal: outcome.snapshot.toolProposals.length > 0,
        message: `provider stream backpressure exceeded ${outcome.limit}`,
      };
    case "turn-error":
      return {
        kind: "failed",
        category: "adapter",
        retryable: false,
        effect: "none",
        observedContent: outcome.snapshot === null ? false : observed(outcome.snapshot),
        emittedToolProposal: (outcome.snapshot?.toolProposals.length ?? 0) > 0,
        message: `turn transition failed: ${outcome.error.code}`,
      };
    default:
      return assertNever(outcome, "unhandled provider stream outcome");
  }
}

function factFromToolLoop(outcome: ToolCallLoopOutcome): AttemptFact {
  const effect = foldToolEffects(
    outcome.results.map((record) => {
      const result = record.outcome;
      switch (result.status) {
        case "completed":
          return "completed";
        case "failed":
        case "cancelled":
        case "timed-out":
        case "partial":
          return result.effect;
        case "uncertain":
          return "uncertain";
        case "denied":
        case "unavailable":
        case "malformed":
          return "none";
        default:
          return assertNever(result, "unhandled tool result effect");
      }
    }),
  );
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "completed",
        finishReason: "stop",
        observedContent: true,
        emittedToolProposal: outcome.results.length > 0,
      };
    case "cancelled":
      return { kind: "cancelled", effect: outcome.effect };
    case "timed-out":
      return { kind: "timed-out", effect: outcome.effect, retryable: outcome.effect === "none" };
    case "partial":
      return {
        kind: "partial",
        reason: outcome.reason,
        effect: outcome.effect,
        observedContent: outcome.results.length > 0,
        emittedToolProposal: true,
      };
    case "uncertain":
      return {
        kind: "failed",
        category: "other",
        retryable: false,
        effect: "uncertain",
        observedContent: outcome.results.length > 0,
        emittedToolProposal: true,
        message: outcome.recoveryHint,
      };
    case "denied":
    case "malformed":
    case "unavailable":
    case "failed":
      return {
        kind: "failed",
        category:
          outcome.kind === "malformed"
            ? "malformed"
            : outcome.kind === "unavailable"
              ? "unsupported"
              : "other",
        retryable: false,
        effect: outcome.kind === "failed" ? outcome.effect : effect,
        observedContent: outcome.results.length > 0,
        emittedToolProposal: true,
        message: outcome.reason,
      };
    case "bound-exceeded":
      return {
        kind: "failed",
        category: "invalid-request",
        retryable: false,
        effect,
        observedContent: outcome.results.length > 0,
        emittedToolProposal: true,
        message: `${outcome.bound} exceeded`,
      };
    case "turn-error":
      return {
        kind: "failed",
        category: "adapter",
        retryable: false,
        effect,
        observedContent: outcome.results.length > 0,
        emittedToolProposal: true,
        message: `turn transition failed: ${outcome.error.code}`,
      };
    default:
      return assertNever(outcome, "unhandled tool loop outcome");
  }
}

function effectFromToolResults(outcome: ToolCallLoopOutcome): EffectCertainty {
  return foldToolEffects(
    outcome.results.map((record) => {
      switch (record.outcome.status) {
        case "completed":
          return "completed";
        case "failed":
        case "cancelled":
        case "timed-out":
        case "partial":
          return record.outcome.effect;
        case "uncertain":
          return "uncertain";
        case "denied":
        case "unavailable":
        case "malformed":
          return "none";
        default:
          return assertNever(record.outcome, "unhandled retained tool effect");
      }
    }),
  );
}

function retainToolHistory(fact: AttemptFact, outcome: ToolCallLoopOutcome): AttemptFact {
  if (outcome.results.length === 0) {
    return fact;
  }
  const effect = effectFromToolResults(outcome);
  switch (fact.kind) {
    case "completed":
      return { ...fact, emittedToolProposal: true };
    case "failed":
    case "partial":
      return {
        ...fact,
        effect: foldToolEffects([fact.effect, effect]),
        emittedToolProposal: true,
      };
    case "cancelled":
    case "timed-out":
      return { ...fact, effect: foldToolEffects([fact.effect, effect]) };
    case "refusal":
      return { ...fact, effect: foldToolEffects([fact.effect, effect]) };
    case "routing-refused":
      return fact;
    default:
      return assertNever(fact, "unhandled attempt fact with tool history");
  }
}

function invalidAttempt(message: string): AttemptRunnerResult {
  return {
    fact: {
      kind: "failed",
      category: "invalid-request",
      retryable: false,
      effect: "none",
      observedContent: false,
      emittedToolProposal: false,
      message,
    },
    turn: null,
  };
}

function aggregateProviderUsage(usage: readonly (UsageUnits | null)[]): UsageUnits | null {
  if (
    usage.length === 0 ||
    usage.some(
      (entry) =>
        entry === null ||
        entry.provenance !== "provider-reported" ||
        entry.inputTokens === undefined ||
        entry.outputTokens === undefined,
    )
  ) {
    return null;
  }
  return {
    provenance: "provider-reported",
    inputTokens: usage.reduce((total, entry) => total + (entry?.inputTokens ?? 0), 0),
    outputTokens: usage.reduce((total, entry) => total + (entry?.outputTokens ?? 0), 0),
    ...(usage.every((entry) => entry?.totalTokens !== undefined)
      ? { totalTokens: usage.reduce((total, entry) => total + (entry?.totalTokens ?? 0), 0) }
      : {}),
    ...(usage.every((entry) => entry?.cachedInputTokens !== undefined)
      ? {
          cachedInputTokens: usage.reduce(
            (total, entry) => total + (entry?.cachedInputTokens ?? 0),
            0,
          ),
        }
      : {}),
    ...(usage.every((entry) => entry?.cacheWriteInputTokens !== undefined)
      ? {
          cacheWriteInputTokens: usage.reduce(
            (total, entry) => total + (entry?.cacheWriteInputTokens ?? 0),
            0,
          ),
        }
      : {}),
    ...(usage.every((entry) => entry?.reasoningTokens !== undefined)
      ? {
          reasoningTokens: usage.reduce((total, entry) => total + (entry?.reasoningTokens ?? 0), 0),
        }
      : {}),
  };
}

function replaceBriefGuidance(messages: ModelMessage[], source: string, guidance: string): boolean {
  const marker = `[brief source=${source}]`;
  for (const [index, entry] of messages.entries()) {
    if (entry.role !== "system") {
      continue;
    }
    const text = entry.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
    const start = text.indexOf(marker);
    if (start < 0) {
      continue;
    }
    const contentStart = start + marker.length;
    const nextSection = text.indexOf("\n\n[", contentStart);
    const end = nextSection < 0 ? text.length : nextSection;
    messages[index] = {
      role: "system",
      parts: [
        { kind: "text", text: `${text.slice(0, contentStart)}\n${guidance}${text.slice(end)}` },
      ],
    };
    return true;
  }
  return false;
}

function validateDisclosure(request: AttemptRunnerRequest, registry: ToolRegistry): string | null {
  const input = request.modelInput;
  if (input === null) {
    return "attempt model input is required";
  }
  if (input.promptCache !== undefined) {
    const stableMessages = input.messages.slice(0, input.promptCache.stableMessageCount);
    if (
      input.promptCache.stableMessageCount < 1 ||
      stableMessages.length !== input.promptCache.stableMessageCount ||
      stableMessages.some(
        (message) =>
          message.role !== "system" ||
          !message.parts.some((part) => part.kind === "text" && part.text.length > 0),
      ) ||
      promptCacheStablePrefixDigest(stableMessages, input.tools) !==
        input.promptCache.stablePrefixDigest
    ) {
      return "prompt cache prefix is stale or mismatched";
    }
  }
  const disclosed = input.disclosure.tools;
  if (
    input.tools.length !== disclosed.length ||
    input.disclosure.toolNames.length !== disclosed.length
  ) {
    return "capability disclosure does not match the provider tool set";
  }
  const seen = new Set<string>();
  for (const [index, receipt] of disclosed.entries()) {
    const definition = input.tools[index];
    const disclosedName = input.disclosure.toolNames[index];
    if (
      definition === undefined ||
      definition.name !== receipt.name ||
      disclosedName !== receipt.name ||
      seen.has(receipt.name)
    ) {
      return "capability disclosure order or identity is invalid";
    }
    seen.add(receipt.name);
    const entry = registry.resolveByName(receipt.name);
    if (
      entry === null ||
      entry.manifest.capabilityId !== receipt.capabilityId ||
      entry.manifest.version !== receipt.version ||
      entry.manifest.description !== definition.description
    ) {
      return "capability disclosure descriptor is stale or mismatched";
    }
    const measured = measureProductToolSchema(definition.parameters);
    if (
      measured.digest !== receipt.schemaDigest ||
      measured.bytes !== receipt.schemaBytes ||
      measured.tokensEstimated !== receipt.schemaTokensEstimated
    ) {
      return "capability disclosure schema is mismatched";
    }
  }
  return null;
}

function unionSet<T>(
  left: ReadonlySet<T> | undefined,
  right: readonly T[],
): ReadonlySet<T> | undefined {
  if ((left?.size ?? 0) === 0 && right.length === 0) {
    return undefined;
  }
  return new Set([...(left ?? []), ...right]);
}

function toolPolicyForExecution(
  policy: EffectiveExecutionPolicy,
  base: ToolPolicyProfile | undefined,
): ToolPolicyProfile {
  const deniedNames = unionSet(base?.deniedNames, policy.deniedToolNames);
  const deniedEffects = unionSet(base?.deniedEffects, policy.deniedEffects);
  return {
    ...(deniedNames === undefined ? {} : { deniedNames }),
    ...(base?.deniedCapabilityIds === undefined
      ? {}
      : { deniedCapabilityIds: base.deniedCapabilityIds }),
    ...(deniedEffects === undefined ? {} : { deniedEffects }),
    ...(base?.autoAllowEffects === undefined ? {} : { autoAllowEffects: base.autoAllowEffects }),
    ...(base?.forceConfirmationEffects === undefined
      ? {}
      : { forceConfirmationEffects: base.forceConfirmationEffects }),
  };
}

function modelRequest(
  request: AttemptRunnerRequest,
  input: AttemptModelInput,
  messages: readonly ModelMessage[],
  budgets: ModelBudgets,
  sequence: number,
): ModelRequest {
  return {
    requestId: modelRequestId.from(`${request.identity.modelAttemptId}-request-${sequence}`),
    providerId: request.receipt.providerId,
    modelId: request.receipt.modelId,
    messages: [...messages],
    tools: [...input.tools],
    output: input.output,
    budgets,
    reasoning: request.receipt.reasoning,
    reasoningControl: request.receipt.reasoningControl,
    ...(request.promptCache === undefined ? {} : { promptCache: request.promptCache }),
    metadata: {
      role: request.receipt.role,
      ...(request.receipt.intent === null ? {} : { workIntent: request.receipt.intent }),
      configurationGeneration: Number(request.boundConfigurationGeneration),
      providerCatalogGeneration: request.receipt.catalogGeneration,
      modelCapabilitySchemaVersion: request.receipt.modelCapabilitySchemaVersion,
    },
  };
}

export function createProductAttemptRunner(
  options: ProductAttemptRunnerOptions,
): AttemptRunnerPort {
  return {
    async run(request) {
      const input = request.modelInput;
      const disclosureError = validateDisclosure(request, options.registry);
      if (disclosureError !== null || input === null) {
        return invalidAttempt(disclosureError ?? "attempt model input is required");
      }
      if (input.disclosure.catalogGeneration !== options.registry.generation) {
        return invalidAttempt("capability disclosure generation is stale");
      }
      if (request.receipt.providerId !== options.provider.identity.providerId) {
        return invalidAttempt("selected provider adapter does not match the route");
      }
      if (request.receipt.providerProfileId !== options.provider.identity.profileId) {
        return invalidAttempt("selected provider profile does not match the route");
      }
      if (request.receipt.providerAdapterKind !== options.provider.identity.adapterKind) {
        return invalidAttempt("selected provider adapter kind does not match the route");
      }
      if (request.receipt.providerDestinationId !== options.provider.identity.destinationId) {
        return invalidAttempt("selected provider destination does not match the route");
      }
      if (!options.provider.supportedModels.includes(request.receipt.modelId)) {
        return invalidAttempt("selected model is unavailable on the provider adapter");
      }

      let budgets = effectiveBudgets(request);
      const deadline = attemptDeadline(request.signal, budgets.wallTimeMs);
      const messages: ModelMessage[] = [...input.messages];
      const assistantText: string[] = [];
      const reasoningText: string[] = [];
      const effectLedger = new Map<string, ToolInvocationRecord["outcome"]>();
      let requestSequence = 0;
      let sentResults = 0;
      const usage: (UsageUnits | null)[] = [];
      let briefRequest = input.brief?.request ?? null;
      let briefReceipt = input.brief?.receipt ?? null;
      let briefFailure: string | null = null;
      const continuation: { terminal: ProviderStreamConsumeOutcome | null } = { terminal: null };

      const gateway = createProductToolGateway({
        clock: options.clock,
        registry: options.registry,
        runner: options.toolRunner,
        hooks: options.hooks,
        journal: options.journal,
        correlation: options.correlation,
        turnId: request.turnId,
        disclosedToolNames: new Set(input.disclosure.toolNames),
        policy: toolPolicyForExecution(
          input.executionPolicy ??
            resolveExecutionProfile("agent", request.boundConfigurationGeneration),
          options.policy,
        ),
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
        effectLedger,
      });
      const consumer = createProviderStreamConsumer({
        clock: options.clock,
        coordinator: options.coordinator,
      });

      const consume = async (): Promise<ProviderStreamConsumeOutcome> => {
        requestSequence += 1;
        const currentRequest = modelRequest(request, input, messages, budgets, requestSequence);
        const outcome = await consumer.consume({
          turnId: request.turnId,
          configurationGeneration: request.configurationGeneration,
          events: options.provider.stream(currentRequest, { signal: deadline.signal }),
          signal: deadline.signal,
          abortAs: () => (deadline.timedOut() ? "timeout" : "cancel"),
        });
        if (outcome.snapshot !== null && outcome.snapshot.text.length > 0) {
          assistantText.push(outcome.snapshot.text);
        }
        if (outcome.snapshot !== null && outcome.snapshot.reasoning.length > 0) {
          reasoningText.push(outcome.snapshot.reasoning);
        }
        usage.push(outcome.snapshot?.usage ?? null);
        return outcome;
      };

      const output = (toolResults: number): NonNullable<AttemptRunnerResult["output"]> => ({
        text: assistantText.join(""),
        reasoning: reasoningText.join(""),
        toolResults,
        providerRequests: requestSequence,
        usage: aggregateProviderUsage(usage),
        briefReceipt,
      });

      try {
        const initial = await consume();
        if (initial.kind !== "finished" || initial.toolProposals.length === 0) {
          return {
            fact: factFromStream(initial),
            turn: initial.turn,
            output: output(0),
          };
        }

        messages.push(assistantToolMessage(initial.snapshot.text, initial.toolProposals));
        const loop = createToolCallLoop({
          coordinator: options.coordinator,
          catalog: options.registry.catalog,
          runner: gateway,
        });
        const loopOutcome = await loop.run({
          turnId: request.turnId,
          configurationGeneration: request.configurationGeneration,
          proposals: initial.toolProposals,
          signal: deadline.signal,
          abortAs: () => (deadline.timedOut() ? "timeout" : "cancel"),
          invocationIdPrefix: String(request.identity.modelAttemptId),
          async continueModel(context) {
            const nextResults = context.results.slice(sentResults);
            sentResults = context.results.length;
            messages.push(...nextResults.map(toolResultMessage));
            if (briefRequest !== null && input.brief !== undefined) {
              const nextRequest = {
                ...briefRequest,
                need: briefNeedAfterToolResults(briefRequest.need, nextResults),
              };
              const projected = createBriefComposer().projectForTurn(request.turnId, nextRequest);
              if (!projected.ok) {
                briefFailure = projected.error.code;
                return { kind: "stop" };
              }
              if (
                !replaceBriefGuidance(
                  messages,
                  input.brief.sectionSource,
                  projected.value.projection.guidance,
                )
              ) {
                briefFailure = "section-missing";
                return { kind: "stop" };
              }
              briefRequest = nextRequest;
              briefReceipt = projected.value.projection.receipt;
              budgets = {
                ...budgets,
                maxOutputTokens: minBudget(
                  minBudget(
                    input.brief.maxOutputTokensCeiling,
                    request.receipt.budgets.outputTokens,
                  ),
                  briefReceipt.outputTokenBudget,
                ),
              };
            }
            const continued = await consume();
            continuation.terminal = continued;
            if (continued.kind !== "finished" || continued.toolProposals.length === 0) {
              return { kind: "stop" };
            }
            messages.push(assistantToolMessage(continued.snapshot.text, continued.toolProposals));
            return { kind: "continue", proposals: continued.toolProposals };
          },
        });

        const terminalStream = continuation.terminal;
        const fact =
          briefFailure !== null
            ? {
                kind: "failed" as const,
                category: "invalid-request" as const,
                retryable: false,
                effect: effectFromToolResults(loopOutcome),
                observedContent: loopOutcome.results.length > 0,
                emittedToolProposal: true,
                message: `Brief continuation failed (${briefFailure})`,
              }
            : terminalStream !== null &&
                (terminalStream.kind !== "finished" || terminalStream.toolProposals.length === 0)
              ? retainToolHistory(factFromStream(terminalStream), loopOutcome)
              : factFromToolLoop(loopOutcome);
        return {
          fact,
          turn: loopOutcome.turn,
          output: output(loopOutcome.results.length),
        };
      } finally {
        deadline.dispose();
      }
    },
  };
}
