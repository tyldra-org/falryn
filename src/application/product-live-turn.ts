/** One application-owned live-turn path for headless and OpenTUI hosts (#787). */

import type {
  ClockPort,
  EvidenceCandidate,
  PromptSectionInput,
  RuntimeEvent,
  TerminalOutcome,
  TurnId,
} from "../domain/index.ts";
import {
  DEFAULT_INTENT_ROLE_MAP,
  type ModelCatalog,
  type ModelPolicy,
  type ProviderAdapterPort,
  type WorkIntent,
} from "../providers/index.ts";
import { createContextPlanner } from "./context-planner.ts";
import type { ProductAgentRuntime } from "./product-agent-runtime.ts";
import { attemptModelInputFromPrompt } from "./product-model-input.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { createTurnAttemptPolicy } from "./turn-attempt-policy.ts";

export type ProductLiveTurnInput = {
  readonly prompt: string;
  readonly turnId: TurnId;
  readonly signal?: AbortSignal;
  readonly intent?: WorkIntent;
  readonly otherSections?: readonly PromptSectionInput[];
};

export type ProductLiveTurnResult = {
  readonly kind: "completed" | "unavailable" | "failed";
  readonly code: string;
  readonly message: string;
  readonly response: string;
  readonly terminalOutcome: TerminalOutcome;
  readonly events: readonly RuntimeEvent[];
  readonly contextPackItems: number;
  readonly modelAttempts: number;
  readonly toolResults: number;
  readonly disclosedTools: number;
};

export type ProductLiveTurnExecutor = {
  /** Persist `session.started` before accepting the first turn. */
  startSession(): Promise<ProductLiveTurnResult | null>;
  /** Compose, execute, journal, and project one complete model turn. */
  run(input: ProductLiveTurnInput): Promise<ProductLiveTurnResult>;
};

export type ProductLiveTurnExecutorOptions = {
  readonly runtime: ProductAgentRuntime;
  readonly clock: ClockPort;
  readonly providerCatalog: ModelCatalog | null;
  readonly contextCandidates?: () => readonly EvidenceCandidate[];
};

const FAILED: TerminalOutcome = { kind: "failed", effect: "none" };

/** Build the default coding policy for a selected provider catalog. */
export function productModelPolicy(
  adapter: ProviderAdapterPort,
  catalog: ModelCatalog,
): ModelPolicy | null {
  const selected = catalog.models[0];
  if (selected === undefined) {
    return null;
  }
  return {
    roles: {
      default: {
        providerId: adapter.identity.providerId,
        modelId: selected.modelId,
        reasoning: "provider-default",
        fallbacks: [],
        budgets: {},
      },
    },
    intents: DEFAULT_INTENT_ROLE_MAP,
  };
}

export function createProductLiveTurnExecutor(
  options: ProductLiveTurnExecutorOptions,
): ProductLiveTurnExecutor {
  const producer = options.runtime.attachments.turnProducer;
  const correlation = options.runtime.correlation;
  let sessionStarted = false;

  const result = (fields: Omit<ProductLiveTurnResult, "events">): ProductLiveTurnResult => ({
    ...fields,
    events: producer.events(),
  });

  async function startSession(): Promise<ProductLiveTurnResult | null> {
    if (sessionStarted) {
      return null;
    }
    const started = await producer.startSession({
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      configurationGeneration: correlation.configurationGeneration,
    });
    if (!started.ok) {
      return result({
        kind: "failed",
        code: `producer.${started.error.code}`,
        message: `session could not start (${started.error.code})`,
        response: "",
        terminalOutcome: FAILED,
        contextPackItems: 0,
        modelAttempts: 0,
        toolResults: 0,
        disclosedTools: 0,
      });
    }
    sessionStarted = true;
    return null;
  }

  async function settleFailure(
    input: ProductLiveTurnInput,
    fields: Pick<ProductLiveTurnResult, "kind" | "code" | "message"> &
      Partial<
        Pick<
          ProductLiveTurnResult,
          "contextPackItems" | "modelAttempts" | "toolResults" | "disclosedTools"
        >
      >,
  ): Promise<ProductLiveTurnResult> {
    const completed = await producer.completeTurn({
      turnId: input.turnId,
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
      outcome: FAILED,
    });
    await producer.refreshFromStore();
    return result({
      kind: fields.kind,
      code: completed.ok ? fields.code : `${fields.code}+producer.${completed.error.code}`,
      message: completed.ok
        ? fields.message
        : `${fields.message}; turn completion failed (${completed.error.code})`,
      response: "",
      terminalOutcome: FAILED,
      contextPackItems: fields.contextPackItems ?? 0,
      modelAttempts: fields.modelAttempts ?? 0,
      toolResults: fields.toolResults ?? 0,
      disclosedTools: fields.disclosedTools ?? 0,
    });
  }

  return {
    startSession,
    async run(input) {
      const sessionFailure = await startSession();
      if (sessionFailure !== null) {
        return sessionFailure;
      }

      const startedTurn = await producer.startTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        traceId: correlation.traceId,
        configurationGeneration: correlation.configurationGeneration,
      });
      if (!startedTurn.ok) {
        return result({
          kind: "failed",
          code: `producer.${startedTurn.error.code}`,
          message: `turn could not start (${startedTurn.error.code})`,
          response: "",
          terminalOutcome: FAILED,
          contextPackItems: 0,
          modelAttempts: 0,
          toolResults: 0,
          disclosedTools: 0,
        });
      }

      const registry = options.runtime.toolRegistry;
      if (registry === null) {
        return settleFailure(input, {
          kind: "unavailable",
          code: "runtime.tool-registry-required",
          message: "the executable tool registry is unavailable",
        });
      }
      const disclosure = discloseProductTools(registry);
      const planned = createContextPlanner().composeTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        configurationGeneration: correlation.configurationGeneration,
        task: input.prompt,
        candidates: options.contextCandidates?.() ?? [],
        tools: disclosure.promptTools,
        otherSections: input.otherSections ?? [],
      });
      if (!planned.ok) {
        return settleFailure(input, {
          kind: "failed",
          code: "context.planner-failed",
          message: `context planner could not compose (${
            "code" in planned.error ? planned.error.code : "failed"
          })`,
          disclosedTools: disclosure.receipt.disclosed.length,
        });
      }

      const provider = options.runtime.requireProviderAdapter();
      if (!provider.ok) {
        return settleFailure(input, {
          kind: "unavailable",
          code: "provider.adapter-required",
          message: "the selected provider connection is unavailable",
          contextPackItems: planned.value.plan.pack.items.length,
          disclosedTools: disclosure.receipt.disclosed.length,
        });
      }
      const attemptRunner = options.runtime.requireAttemptRunner();
      const policy =
        options.providerCatalog === null
          ? null
          : productModelPolicy(provider.value, options.providerCatalog);
      if (!attemptRunner.ok || options.providerCatalog === null || policy === null) {
        return settleFailure(input, {
          kind: "unavailable",
          code: "runtime.attempt-runner-required",
          message:
            options.providerCatalog === null
              ? "the selected provider has no usable model catalog"
              : policy === null
                ? "the selected provider catalog contains no model"
                : "the product attempt runner is unavailable",
          contextPackItems: planned.value.plan.pack.items.length,
          disclosedTools: disclosure.receipt.disclosed.length,
        });
      }

      const attemptPolicy = createTurnAttemptPolicy({
        clock: options.clock,
        coordinator: options.runtime.turnCoordinator,
        runner: attemptRunner.value,
        policy,
        catalogs: [
          {
            providerId: provider.value.identity.providerId,
            catalog: options.providerCatalog,
          },
        ],
        journal: options.runtime.journal,
      });
      const attempted = await attemptPolicy.run({
        turnId: input.turnId,
        configurationGeneration: correlation.configurationGeneration,
        signal: input.signal ?? new AbortController().signal,
        intent: input.intent ?? "coding",
        modelInput: attemptModelInputFromPrompt(planned.value.prompt, disclosure),
      });
      const terminalOutcome =
        attempted.turn?.status === "terminal" && attempted.turn.outcome !== null
          ? attempted.turn.outcome
          : FAILED;
      const completed = await producer.completeTurn({
        turnId: input.turnId,
        sessionId: correlation.sessionId,
        workspaceId: correlation.workspaceId,
        traceId: correlation.traceId,
        configurationGeneration: correlation.configurationGeneration,
        outcome: terminalOutcome,
      });
      const refreshed = await producer.refreshFromStore();
      const lastAttempt = attempted.attempts.at(-1) ?? null;
      const response = lastAttempt?.output?.text ?? "";
      const toolResults = attempted.attempts.reduce(
        (total, attempt) => total + (attempt.output?.toolResults ?? 0),
        0,
      );
      const succeeded = attempted.kind === "completed" && completed.ok && refreshed.ok;
      return result({
        kind: succeeded ? "completed" : "failed",
        code: succeeded ? "completed" : `runtime.attempt-${attempted.kind}`,
        message: succeeded
          ? "turn completed"
          : !completed.ok
            ? `turn settled as ${attempted.kind}; completion failed (${completed.error.code})`
            : !refreshed.ok
              ? `turn settled as ${attempted.kind}; durable replay failed (${refreshed.error.code})`
              : `turn settled as ${attempted.kind}`,
        response,
        terminalOutcome,
        contextPackItems: planned.value.plan.pack.items.length,
        modelAttempts: attempted.attempts.length,
        toolResults,
        disclosedTools: disclosure.receipt.disclosed.length,
      });
    },
  };
}
