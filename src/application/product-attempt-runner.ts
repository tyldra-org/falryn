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
  foldToolEffects,
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
} from "../providers/index.ts";
import { measureProductToolSchema } from "./product-tool-disclosure.ts";
import {
  createProductToolGateway,
  type ProductToolConfirmationPort,
} from "./product-tool-gateway.ts";
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

function validateDisclosure(request: AttemptRunnerRequest, registry: ToolRegistry): string | null {
  const input = request.modelInput;
  if (input === null) {
    return "attempt model input is required";
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
    metadata: {
      role: request.receipt.role,
      ...(request.receipt.intent === null ? {} : { workIntent: request.receipt.intent }),
      configurationGeneration: Number(request.boundConfigurationGeneration),
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
      if (!options.provider.supportedModels.includes(request.receipt.modelId)) {
        return invalidAttempt("selected model is unavailable on the provider adapter");
      }

      const budgets = effectiveBudgets(request);
      const deadline = attemptDeadline(request.signal, budgets.wallTimeMs);
      const messages: ModelMessage[] = [...input.messages];
      const assistantText: string[] = [];
      const reasoningText: string[] = [];
      const effectLedger = new Map<string, ToolInvocationRecord["outcome"]>();
      let requestSequence = 0;
      let sentResults = 0;
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
        ...(options.policy === undefined ? {} : { policy: options.policy }),
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
        return outcome;
      };

      try {
        const initial = await consume();
        if (initial.kind !== "finished" || initial.toolProposals.length === 0) {
          return {
            fact: factFromStream(initial),
            turn: initial.turn,
            output: {
              text: assistantText.join(""),
              reasoning: reasoningText.join(""),
              toolResults: 0,
            },
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
          terminalStream !== null &&
          (terminalStream.kind !== "finished" || terminalStream.toolProposals.length === 0)
            ? retainToolHistory(factFromStream(terminalStream), loopOutcome)
            : factFromToolLoop(loopOutcome);
        return {
          fact,
          turn: loopOutcome.turn,
          output: {
            text: assistantText.join(""),
            reasoning: reasoningText.join(""),
            toolResults: loopOutcome.results.length,
          },
        };
      } finally {
        deadline.dispose();
      }
    },
  };
}
