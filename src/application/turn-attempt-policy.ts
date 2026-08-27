/**
 * Turn-level retry, fallback, refusal, partial, and terminal policy.
 *
 * Sits above the #43 stream consumer and #44 tool-call loop. Each attempt is
 * visible ({@link AttemptIdentity}), retries are bounded via
 * {@link evaluateRetry}, and fallback reuses `#37` {@link resolveNextFallback}
 * with a visited set so routes never recurse.
 *
 * Optional {@link TurnEventJournalPort} records attempt/turn facts through the
 * existing event store (#46). Replay never re-enters this policy or its runner.
 * Does not talk to live vendor adapters. Callers inject an
 * {@link AttemptRunnerPort} (tests use deterministic doubles).
 */

import {
  type AttemptAction,
  type AttemptClassification,
  type AttemptFact,
  type AttemptFailureCategory,
  type AttemptIdentity,
  assertNever,
  type CapabilityId,
  type ClockPort,
  type ConfigurationGeneration,
  classifyAttempt,
  DEFAULT_RETRY_BACKOFF,
  decideAttemptAction,
  type EffectCertainty,
  evaluateRetry,
  type ModelAttemptBinding,
  type ModelAttemptId,
  modelAttemptId,
  NO_CORRELATION,
  type RetryBackoff,
  type RetryPolicy,
  type TerminalOutcome,
  type TurnCorrelation,
  type TurnId,
  type TurnLifecycleFact,
  type TurnSnapshot,
  terminalOutcomeForClassification,
} from "../domain/index.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import type {
  ModelBudgets,
  ModelMessage,
  ModelPolicy,
  ModelToolDefinition,
  OutputContract,
  ResolveRouteInput,
  RoutedCatalogEntry,
  RoutingOutcome,
  RoutingReceipt,
  WorkIntent,
} from "../providers/index.ts";
import { resolveModelRoute, resolveNextFallback } from "../providers/index.ts";
import { awaitBackoff } from "./recovery.ts";
import type { TurnCoordinator, TurnCoordinatorError } from "./turn-coordinator.ts";
import type { TurnEventJournalPort } from "./turn-event-journal.ts";

/** Immutable provider input shared by every retry/fallback for one turn. */
export type AttemptModelInput = {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly output: OutputContract;
  readonly budgets: ModelBudgets;
  /** Registry generation and concrete names visible to this attempt. */
  readonly disclosure: {
    readonly catalogGeneration: ConfigurationGeneration;
    readonly toolNames: readonly string[];
    readonly discoveryHandle: string;
    readonly families: readonly {
      readonly family: string;
      readonly available: boolean;
      readonly reason: string | null;
    }[];
    readonly tools: readonly {
      readonly name: string;
      readonly capabilityId: CapabilityId;
      readonly version: number;
      readonly schemaDigest: string;
      readonly schemaBytes: number;
      readonly schemaTokensEstimated: number;
    }[];
    readonly omitted: readonly { readonly name: string; readonly reason: string }[];
    readonly schemaBytes: number;
    readonly schemaTokensEstimated: number;
  };
};

export type AttemptRunnerRequest = {
  readonly turnId: TurnId;
  readonly identity: AttemptIdentity;
  readonly receipt: RoutingReceipt;
  /** Immutable configuration/policy snapshot selected for the whole turn. */
  readonly boundConfigurationGeneration: ConfigurationGeneration;
  /** Current turn-machine generation, which may advance during recovery. */
  readonly configurationGeneration: ConfigurationGeneration;
  readonly signal: AbortSignal;
  readonly modelInput: AttemptModelInput | null;
};

export type AttemptRunnerResult = {
  readonly fact: AttemptFact;
  /** Turn after the attempt; may already be terminal when the runner settles. */
  readonly turn: TurnSnapshot | null;
  /** Model-facing output retained by the product entrypoint, never by retry policy. */
  readonly output?: {
    readonly text: string;
    readonly reasoning: string;
    readonly toolResults: number;
  };
};

/**
 * One model attempt. Implementations typically wrap the stream consumer and
 * optional tool-call loop; tests inject deterministic scripts.
 */
export type AttemptRunnerPort = {
  run(request: AttemptRunnerRequest): Promise<AttemptRunnerResult>;
};

export type TurnAttemptPolicyOptions = {
  readonly clock: ClockPort;
  readonly coordinator: TurnCoordinator;
  readonly runner: AttemptRunnerPort;
  readonly policy: ModelPolicy;
  readonly catalogs: readonly RoutedCatalogEntry[];
  readonly retryPolicy?: RetryPolicy;
  readonly backoff?: RetryBackoff;
  /** Injected for deterministic backoff tests. Defaults to 0 (no jitter). */
  readonly jitter?: () => number;
  /** Allocates a branded attempt id. Defaults to `attempt-<n>`. */
  readonly allocateAttemptId?: (attemptNumber: number) => ModelAttemptId;
  /**
   * Optional durable journal (#46). When set, attempt/turn terminals are
   * recorded as facts; replay never re-enters the runner.
   */
  readonly journal?: TurnEventJournalPort;
};

export type RunTurnAttemptPolicyInput = {
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly signal: AbortSignal;
  readonly modelInput?: AttemptModelInput;
  readonly intent?: WorkIntent;
  readonly role?: ResolveRouteInput["role"];
  readonly explicit?: ResolveRouteInput["explicit"];
  readonly required?: ResolveRouteInput["required"];
  /**
   * Elapsed budget across all attempts (ms), or `null` for unbounded.
   * Defaults to `null`.
   */
  readonly elapsedBudgetMs?: number | null;
};

export type AttemptRecord = {
  readonly identity: AttemptIdentity;
  readonly receipt: RoutingReceipt;
  readonly fact: AttemptFact;
  readonly classification: AttemptClassification;
  readonly action: AttemptAction;
  readonly output: AttemptRunnerResult["output"] | null;
};

export type TurnAttemptPolicyOutcome =
  | {
      readonly kind: "completed";
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "refusal";
      readonly source: "model" | "policy" | "provider-safety";
      readonly reason: string;
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "partial";
      readonly reason: string;
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "failed";
      readonly effect: EffectCertainty;
      readonly message: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "cancelled";
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "timed-out";
      readonly effect: EffectCertainty;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "uncertain";
      readonly effect: "uncertain";
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot;
    }
  | {
      readonly kind: "exhausted";
      readonly reason: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "routing-refused";
      readonly code: string;
      readonly detail: string;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    }
  | {
      readonly kind: "turn-error";
      readonly error: TurnCoordinatorError;
      readonly attempts: readonly AttemptRecord[];
      readonly turn: TurnSnapshot | null;
    };

export type TurnAttemptPolicy = {
  run(input: RunTurnAttemptPolicyInput): Promise<TurnAttemptPolicyOutcome>;
};

const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, retryable: true };

function routeKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

/** Map a provider failure kind onto the domain attempt category. */
export function attemptCategoryForProviderFailure(
  kind: ProviderFailureKind,
): AttemptFailureCategory {
  switch (kind) {
    case "network":
      return "transport";
    case "rate-limit":
      return "rate-limit";
    case "authentication":
      return "authentication";
    case "authorization":
      return "authorization";
    case "invalid-request":
      return "invalid-request";
    case "unsupported-capability":
      return "unsupported";
    case "malformed-stream":
      return "malformed";
    case "provider-safety":
      return "safety";
    case "server-failure":
      return "server";
    case "adapter-defect":
      return "adapter";
    case "cancellation":
      return "other";
    case "timeout":
      return "other";
    default:
      return assertNever(kind, "unhandled provider failure kind");
  }
}

export function attemptFactFromProviderFailure(
  failure: ProviderFailure,
  options: {
    readonly effect: EffectCertainty;
    readonly observedContent: boolean;
    readonly emittedToolProposal: boolean;
  },
): AttemptFact {
  if (failure.kind === "cancellation") {
    return { kind: "cancelled", effect: options.effect };
  }
  if (failure.kind === "timeout") {
    return {
      kind: "timed-out",
      effect: options.effect,
      retryable: failure.retryable,
    };
  }
  if (failure.kind === "provider-safety") {
    return {
      kind: "refusal",
      source: "provider-safety",
      reason: failure.message,
      effect: options.effect,
    };
  }
  return {
    kind: "failed",
    category: attemptCategoryForProviderFailure(failure.kind),
    retryable: failure.retryable,
    effect: options.effect,
    observedContent: options.observedContent,
    emittedToolProposal: options.emittedToolProposal,
    message: failure.message,
  };
}

function routingDetail(outcome: Exclude<RoutingOutcome, { kind: "selected" }>): string {
  switch (outcome.kind) {
    case "no-eligible-route":
      return outcome.code;
    case "role-disabled":
      return "role-disabled";
    case "role-unconfigured":
      return "role-unconfigured";
    case "policy-invalid":
      return outcome.code;
    default:
      return assertNever(outcome, "unhandled routing outcome");
  }
}

function advanceToAssemblingContext(
  coordinator: TurnCoordinator,
  turnId: TurnId,
  configurationGeneration: ConfigurationGeneration,
): TurnCoordinatorError | null {
  const snapshot = coordinator.get(turnId);
  if (snapshot === null) {
    return { code: "turn-not-found", turnId };
  }
  if (snapshot.status === "terminal") {
    return null;
  }
  if (snapshot.phase === "assembling-context") {
    return null;
  }
  if (snapshot.phase !== "created" && snapshot.phase !== "orienting") {
    return null;
  }
  if (snapshot.phase === "created") {
    const orient = coordinator.apply({
      turnId,
      command: "begin-orienting",
      configurationGeneration,
    });
    if (!orient.ok) {
      return orient.error;
    }
  }
  const assemble = coordinator.apply({
    turnId,
    command: "begin-assembling-context",
    configurationGeneration,
  });
  if (!assemble.ok) {
    return assemble.error;
  }
  return null;
}

function recoverForNextAttempt(
  coordinator: TurnCoordinator,
  turnId: TurnId,
  nextGeneration: ConfigurationGeneration,
): TurnCoordinatorError | null {
  const snapshot = coordinator.get(turnId);
  if (snapshot === null) {
    return { code: "turn-not-found", turnId };
  }
  if (snapshot.status !== "terminal") {
    return null;
  }
  const recovered = coordinator.apply({
    turnId,
    command: "recover",
    configurationGeneration: nextGeneration,
    recoveryGeneration: nextGeneration,
  });
  if (!recovered.ok) {
    return recovered.error;
  }
  return advanceToAssemblingContext(coordinator, turnId, nextGeneration);
}

function settleCommandFor(
  classification: Exclude<
    AttemptClassification,
    | { readonly kind: "may-retry-same" }
    | { readonly kind: "may-fallback" }
    | { readonly kind: "completed" }
  >,
): {
  readonly command: "fail" | "cancel" | "time-out" | "mark-uncertain";
  readonly effect: EffectCertainty;
} {
  const outcome: TerminalOutcome = terminalOutcomeForClassification(classification);
  switch (outcome.kind) {
    case "failed":
      return { command: "fail", effect: outcome.effect };
    case "cancelled":
      return { command: "cancel", effect: outcome.effect };
    case "timed-out":
      return { command: "time-out", effect: outcome.effect };
    case "uncertain":
      return { command: "mark-uncertain", effect: "uncertain" };
    case "completed":
      return { command: "fail", effect: "none" };
    default:
      return assertNever(outcome, "unhandled terminal outcome");
  }
}

/**
 * Drive a non-terminal turn to a named settlement. Walks the happy-path phase
 * chain when still early so `complete` / `fail` are legal.
 */
function ensureTerminal(
  coordinator: TurnCoordinator,
  turnId: TurnId,
  configurationGeneration: ConfigurationGeneration,
  classification: Exclude<
    AttemptClassification,
    { readonly kind: "may-retry-same" } | { readonly kind: "may-fallback" }
  >,
): TurnSnapshot | null {
  let current = coordinator.get(turnId);
  if (current === null) {
    return null;
  }
  if (current.status === "terminal") {
    return current;
  }

  const phaseOrder = [
    "assembling-context",
    "awaiting-model",
    "handling-model-event",
    "evaluating-completion",
  ] as const;
  const beginCommands = {
    "assembling-context": "begin-awaiting-model",
    "awaiting-model": "begin-handling-model-event",
    "handling-model-event": "begin-evaluating-completion",
  } as const;

  while (current.status === "active") {
    if (current.phase === "evaluating-completion" || current.phase === "executing-capability") {
      break;
    }
    if (current.phase === "orienting" || current.phase === "created") {
      const advanced = advanceToAssemblingContext(coordinator, turnId, configurationGeneration);
      if (advanced !== null) {
        return coordinator.get(turnId);
      }
      current = coordinator.get(turnId) ?? current;
      continue;
    }
    if (!(current.phase in beginCommands)) {
      break;
    }
    const command = beginCommands[current.phase as keyof typeof beginCommands];
    const applied = coordinator.apply({
      turnId,
      command,
      configurationGeneration,
    });
    if (!applied.ok) {
      break;
    }
    current = applied.value.snapshot;
    if (!phaseOrder.includes(current.phase as (typeof phaseOrder)[number])) {
      break;
    }
  }

  current = coordinator.get(turnId);
  if (current === null || current.status === "terminal") {
    return current;
  }

  if (classification.kind === "completed") {
    if (current.phase !== "evaluating-completion") {
      // Best-effort: if still in handling-model-event, move to evaluating.
      if (current.phase === "handling-model-event") {
        coordinator.apply({
          turnId,
          command: "begin-evaluating-completion",
          configurationGeneration,
        });
      }
    }
    coordinator.apply({
      turnId,
      command: "complete",
      configurationGeneration,
    });
    return coordinator.get(turnId);
  }

  const { command, effect } = settleCommandFor(classification);
  coordinator.apply({
    turnId,
    command,
    configurationGeneration,
    effect,
  });
  return coordinator.get(turnId);
}

function mustTurn(coordinator: TurnCoordinator, turnId: TurnId): TurnSnapshot {
  const turn = coordinator.get(turnId);
  if (turn === null) {
    throw new Error(`turn ${turnId} missing after settlement`);
  }
  return turn;
}

function correlationFor(snapshot: TurnSnapshot): TurnCorrelation {
  return {
    workspaceId: snapshot.workspaceId,
    sessionId: snapshot.sessionId,
    traceId: snapshot.traceId,
    configurationGeneration: snapshot.configurationGeneration,
    turnId: snapshot.turnId,
  };
}

function attemptBinding(
  receipt: RoutingReceipt,
  modelInput: AttemptModelInput | undefined,
  generation: ConfigurationGeneration,
): ModelAttemptBinding {
  const disclosure = modelInput?.disclosure;
  return {
    schemaVersion: 1,
    providerId: receipt.providerId,
    modelId: receipt.modelId,
    role: receipt.role,
    intent: receipt.intent,
    reasoning: receipt.reasoning,
    providerCatalogGeneration: receipt.catalogGeneration,
    toolCatalogGeneration: disclosure?.catalogGeneration ?? generation,
    policyGeneration: generation,
    runner: "product-attempt-runner.v1",
    gateway: "product-tool-gateway.v1",
    discoveryHandle: disclosure?.discoveryHandle ?? `tool-catalog:${generation}`,
    families: disclosure?.families ?? [],
    tools: disclosure?.tools ?? [],
    omitted: disclosure?.omitted ?? [],
    schemaBytes: disclosure?.schemaBytes ?? 0,
    schemaTokensEstimated: disclosure?.schemaTokensEstimated ?? 0,
    budgets: {
      attempts: receipt.budgets.attempts ?? null,
      inputTokens: receipt.budgets.inputTokens ?? null,
      outputTokens: receipt.budgets.outputTokens ?? null,
      wallTimeMs: receipt.budgets.wallTimeMs ?? null,
      cost: receipt.budgets.cost ?? null,
    },
  };
}

/** Maps an attempt classification onto the durable attempt terminal fact. */
function outcomeForAttemptRecord(classification: AttemptClassification): TerminalOutcome {
  switch (classification.kind) {
    case "completed":
      return { kind: "completed" };
    case "may-retry-same":
    case "may-fallback":
      return { kind: "failed", effect: classification.effect };
    case "refusal":
    case "partial":
    case "failed":
    case "cancelled":
    case "timed-out":
    case "uncertain":
      return terminalOutcomeForClassification(classification);
    default:
      return assertNever(classification, "unhandled attempt classification");
  }
}

async function persistFacts(
  journal: TurnEventJournalPort | undefined,
  facts: readonly TurnLifecycleFact[],
  signal: AbortSignal,
): Promise<void> {
  if (journal === undefined || facts.length === 0) {
    return;
  }
  await journal.persist(facts, signal);
}

function settleFromClassification(
  coordinator: TurnCoordinator,
  turnId: TurnId,
  configurationGeneration: ConfigurationGeneration,
  attempts: readonly AttemptRecord[],
  classification: Exclude<
    AttemptClassification,
    { readonly kind: "may-retry-same" } | { readonly kind: "may-fallback" }
  >,
  existingTurn: TurnSnapshot | null = null,
): TurnAttemptPolicyOutcome {
  const turn =
    existingTurn?.status === "terminal"
      ? existingTurn
      : (ensureTerminal(coordinator, turnId, configurationGeneration, classification) ??
        existingTurn);

  switch (classification.kind) {
    case "completed":
      return {
        kind: "completed",
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    case "refusal":
      return {
        kind: "refusal",
        source: classification.source,
        reason: classification.reason,
        effect: classification.effect,
        attempts,
        turn,
      };
    case "partial":
      return {
        kind: "partial",
        reason: classification.reason,
        effect: classification.effect,
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    case "failed":
      return {
        kind: "failed",
        effect: classification.effect,
        message: classification.message,
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    case "cancelled":
      return {
        kind: "cancelled",
        effect: classification.effect,
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    case "timed-out":
      return {
        kind: "timed-out",
        effect: classification.effect,
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    case "uncertain":
      return {
        kind: "uncertain",
        effect: "uncertain",
        attempts,
        turn: turn ?? mustTurn(coordinator, turnId),
      };
    default:
      return assertNever(classification, "unhandled settlement classification");
  }
}

export function createTurnAttemptPolicy(options: TurnAttemptPolicyOptions): TurnAttemptPolicy {
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const backoff = options.backoff ?? DEFAULT_RETRY_BACKOFF;
  const jitter = options.jitter ?? (() => 0);

  return {
    async run(input) {
      const allocateAttemptId =
        options.allocateAttemptId ??
        ((attemptNumber: number) =>
          modelAttemptId.from(`attempt:${String(input.turnId)}:${attemptNumber}`));
      const attempts: AttemptRecord[] = [];
      const routeInput: ResolveRouteInput = {
        policy: options.policy,
        catalogs: options.catalogs,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
        ...(input.required === undefined ? {} : { required: input.required }),
        now: options.clock.now(),
      };

      const initial = resolveModelRoute(routeInput);
      if (initial.kind !== "selected") {
        return {
          kind: "routing-refused",
          code: initial.kind,
          detail: routingDetail(initial),
          attempts,
          turn: options.coordinator.get(input.turnId),
        };
      }

      let receipt = initial.receipt;
      const visited = new Set<string>([routeKey(receipt.providerId, receipt.modelId)]);
      let attemptsOnCurrentRoute = 0;
      let elapsedMs = 0;
      let generation = input.configurationGeneration;
      const startedAt = options.clock.now();

      const prepared = advanceToAssemblingContext(options.coordinator, input.turnId, generation);
      if (prepared !== null) {
        return {
          kind: "turn-error",
          error: prepared,
          attempts,
          turn: options.coordinator.get(input.turnId),
        };
      }

      const opened = options.coordinator.get(input.turnId);
      if (opened !== null) {
        await persistFacts(
          options.journal,
          [{ kind: "turn.started", correlation: correlationFor(opened) }],
          input.signal,
        );
      }

      while (true) {
        if (input.signal.aborted) {
          const cancelled = settleFromClassification(
            options.coordinator,
            input.turnId,
            generation,
            attempts,
            {
              kind: "cancelled",
              effect: "none",
            },
          );
          const settled = options.coordinator.get(input.turnId);
          if (settled?.status === "terminal") {
            await persistFacts(
              options.journal,
              [
                {
                  kind: "turn.completed",
                  correlation: correlationFor(settled),
                  outcome: settled.outcome,
                },
              ],
              input.signal,
            );
          }
          return cancelled;
        }

        const current = options.coordinator.get(input.turnId);
        if (current?.status === "terminal") {
          const nextGeneration = (generation + 1) as ConfigurationGeneration;
          const recovered = recoverForNextAttempt(
            options.coordinator,
            input.turnId,
            nextGeneration,
          );
          if (recovered !== null) {
            return {
              kind: "turn-error",
              error: recovered,
              attempts,
              turn: options.coordinator.get(input.turnId),
            };
          }
          generation = nextGeneration;
        }

        const attemptNumber = attempts.length + 1;
        const identity: AttemptIdentity = {
          attemptNumber,
          modelAttemptId: allocateAttemptId(attemptNumber),
          fallbackPosition: receipt.fallbackPosition,
          providerKey: receipt.providerId,
          modelKey: receipt.modelId,
        };

        const live = options.coordinator.get(input.turnId);
        if (live !== null) {
          await persistFacts(
            options.journal,
            [
              {
                kind: "model.attempt.started",
                correlation: correlationFor(live),
                modelAttemptId: identity.modelAttemptId,
                binding: attemptBinding(receipt, input.modelInput, input.configurationGeneration),
              },
            ],
            input.signal,
          );
        }

        const runnerResult = await options.runner.run({
          turnId: input.turnId,
          identity,
          receipt,
          boundConfigurationGeneration: input.configurationGeneration,
          configurationGeneration: generation,
          signal: input.signal,
          modelInput: input.modelInput ?? null,
        });

        elapsedMs = Math.max(elapsedMs, Number(options.clock.now()) - Number(startedAt));

        const classification = classifyAttempt(runnerResult.fact);
        const fallbackProbe = resolveNextFallback(
          { ...routeInput, visited, now: options.clock.now() },
          receipt,
        );
        const fallbackAvailable = fallbackProbe.kind === "selected";

        let retryDecision = null;
        if (classification.kind === "may-retry-same") {
          attemptsOnCurrentRoute += 1;
          retryDecision = evaluateRetry({
            error: {
              code: "provider.attempt.retryable",
              category: "provider",
              message: classification.message,
              retryable: true,
              effect: classification.effect,
              cause: null,
              correlation: { ...NO_CORRELATION, turnId: input.turnId },
              recovery: ["retry"],
              exitCategory: "runtime-error",
              related: [],
              relatedDropped: 0,
              recognized: true,
            },
            policy: retryPolicy,
            attemptsMade: attemptsOnCurrentRoute,
            elapsedMs,
            elapsedBudgetMs: input.elapsedBudgetMs ?? null,
            idempotent: true,
            cancelled: input.signal.aborted,
            backoff,
            jitter,
          });
        }

        const action = decideAttemptAction({
          classification,
          retryDecision,
          fallbackAvailable,
        });

        attempts.push({
          identity,
          receipt,
          fact: runnerResult.fact,
          classification,
          action,
          output: runnerResult.output ?? null,
        });

        const attemptOutcome = outcomeForAttemptRecord(classification);
        const afterAttempt = options.coordinator.get(input.turnId);
        if (afterAttempt !== null) {
          await persistFacts(
            options.journal,
            [
              {
                kind: "model.attempt.completed",
                correlation: correlationFor(afterAttempt),
                modelAttemptId: identity.modelAttemptId,
                outcome: attemptOutcome,
              },
            ],
            input.signal,
          );
        }

        switch (action.kind) {
          case "settle": {
            const settled = settleFromClassification(
              options.coordinator,
              input.turnId,
              generation,
              attempts,
              action.classification,
              runnerResult.turn,
            );
            const terminal = options.coordinator.get(input.turnId);
            if (terminal?.status === "terminal") {
              await persistFacts(
                options.journal,
                [
                  {
                    kind: "turn.completed",
                    correlation: correlationFor(terminal),
                    outcome: terminal.outcome,
                  },
                ],
                input.signal,
              );
            }
            return settled;
          }
          case "retry-same": {
            const waited = await awaitBackoff(
              options.clock,
              { kind: "retry", attempt: action.attempt, delayMs: action.delayMs },
              input.signal,
            );
            if (waited === "cancelled" || input.signal.aborted) {
              const cancelled = settleFromClassification(
                options.coordinator,
                input.turnId,
                generation,
                attempts,
                { kind: "cancelled", effect: "none" },
              );
              const terminal = options.coordinator.get(input.turnId);
              if (terminal?.status === "terminal") {
                await persistFacts(
                  options.journal,
                  [
                    {
                      kind: "turn.completed",
                      correlation: correlationFor(terminal),
                      outcome: terminal.outcome,
                    },
                  ],
                  input.signal,
                );
              }
              return cancelled;
            }
            continue;
          }
          case "fallback": {
            if (fallbackProbe.kind !== "selected") {
              return {
                kind: "exhausted",
                reason: "fallback-exhausted",
                attempts,
                turn: options.coordinator.get(input.turnId),
              };
            }
            receipt = fallbackProbe.receipt;
            visited.add(routeKey(receipt.providerId, receipt.modelId));
            attemptsOnCurrentRoute = 0;
            continue;
          }
          case "exhausted":
            return {
              kind: "exhausted",
              reason: action.reason,
              attempts,
              turn: options.coordinator.get(input.turnId),
            };
          default:
            return assertNever(action, "unhandled attempt action");
        }
      }
    },
  };
}
