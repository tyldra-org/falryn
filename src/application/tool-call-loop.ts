/**
 * Iterative tool-call loop with cancellation and bounded iterations.
 *
 * Consumes validated proposals from the provider-stream path (#43), binds them
 * against a tool catalog, executes only through {@link ToolRunnerPort}, and
 * drives the turn coordinator through `executing-capability` with optional
 * cycles back to the model. Providers, UI, and agents never touch files or
 * processes directly.
 *
 * Retry/fallback/refusal/partial settlement is owned by `turn-attempt-policy`
 * (#45). Durable persist/replay of turn events is owned by
 * `turn-event-journal` (#46). Product workspace/Git/shell tools are out of
 * scope — callers inject a deterministic runner for tests and later adapters.
 */

import {
  assertNever,
  type BoundToolInvocation,
  bindToolProposals,
  type ConfigurationGeneration,
  type EffectCertainty,
  effectOfToolOutcome,
  foldToolEffects,
  invocationId,
  MAX_CONCURRENT_TOOLS,
  MAX_TOOL_CALLS_PER_ITERATION,
  MAX_TOOL_LOOP_ITERATIONS,
  type ToolBindError,
  type ToolInvocationOutcome,
  type ToolInvocationRecord,
  type ToolProposal,
  type TurnId,
  type TurnSnapshot,
} from "../domain/index.ts";
import type { AssembledToolProposal } from "../providers/index.ts";
import {
  DEFAULT_TOOL_CALL_LOOP_LIMITS,
  type ToolCallLoop,
  type ToolCallLoopLimits,
  type ToolCallLoopOptions,
  type ToolCallLoopOutcome,
  type ToolRunnerPort,
} from "./tool-call-loop/contracts.ts";
import type { TurnCoordinator, TurnCoordinatorError } from "./turn-coordinator.ts";

export * from "./tool-call-loop/contracts.ts";

export function createToolCallLoop(options: ToolCallLoopOptions): ToolCallLoop {
  const limits = normalizeLimits(options.limits);
  const { coordinator, catalog, runner } = options;

  return {
    async run(input) {
      const results: ToolInvocationRecord[] = [];
      const seenToolCallIds = new Set<string>();
      const fallbackVisited = new Set<string>();
      let fallbackTransitions = 0;
      let iteration = 0;
      let proposals = toProposals(input.proposals);
      const abortAs = (): "cancel" | "timeout" =>
        typeof input.abortAs === "function" ? input.abortAs() : (input.abortAs ?? "cancel");

      const beginExecute = applyCommand(
        coordinator,
        input.turnId,
        "begin-executing-capability",
        input.configurationGeneration,
      );
      if (!beginExecute.ok) {
        return {
          kind: "turn-error",
          error: beginExecute.error,
          iterations: 0,
          results,
          turn: coordinator.get(input.turnId),
        };
      }

      while (true) {
        if (input.signal.aborted) {
          return settleAbort({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            abortAs: abortAs(),
            iterations: iteration,
            results,
            // Nothing executed this iteration yet.
            inFlightEffect: "none",
          });
        }

        if (iteration >= limits.maxIterations) {
          return {
            kind: "bound-exceeded",
            bound: "max-iterations",
            maximum: limits.maxIterations,
            attempted: iteration + 1,
            iterations: iteration,
            results,
            turn: coordinator.get(input.turnId),
          };
        }

        iteration += 1;

        const repeated = proposals.find((proposal) => seenToolCallIds.has(proposal.toolCallId));
        if (repeated !== undefined) {
          return settleBindFailure({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            error: { code: "duplicate-tool-call-id", toolCallId: repeated.toolCallId },
            iterations: iteration,
            results,
          });
        }
        for (const proposal of proposals) {
          seenToolCallIds.add(proposal.toolCallId);
        }

        const bound = bindToolProposals({
          catalog,
          proposals,
          maxQueued: limits.maxToolCallsPerIteration,
          nextInvocationId: (proposal) =>
            invocationId.from(
              `${input.invocationIdPrefix ?? "tool"}-inv-${iteration}-${proposal.toolCallId}`,
            ),
        });

        if (!bound.ok) {
          return settleBindFailure({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            error: bound.error,
            iterations: iteration,
            results,
          });
        }

        if (bound.value.length === 0) {
          return finishTurn({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            iterations: iteration,
            results,
          });
        }

        const executed = await executeBoundBatch({
          batch: bound.value,
          runner,
          signal: input.signal,
          maxConcurrent: limits.maxConcurrentTools,
        });

        results.push(...executed.records);

        if (executed.aborted) {
          return settleAbort({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            abortAs: abortAs(),
            iterations: iteration,
            results,
            inFlightEffect: foldToolEffects(
              executed.records.map((record) => effectOfToolOutcome(record.outcome)),
            ),
          });
        }

        const preTerminal = classifyPreTerminal(executed.records);
        const fallback =
          preTerminal?.kind === "unavailable" && input.continueModel !== undefined
            ? resolveExplicitFallback(
                executed.records,
                options.fallbackPolicy,
                fallbackVisited,
                fallbackTransitions,
                limits.maxIterations,
              )
            : null;
        if (preTerminal !== null && fallback?.kind !== "available") {
          return settleClassified({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            iterations: iteration,
            results,
            classified:
              fallback?.kind === "exhausted"
                ? { kind: "unavailable", reason: fallback.reason }
                : preTerminal,
          });
        }

        if (input.continueModel === undefined) {
          return finishTurn({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            iterations: iteration,
            results,
          });
        }

        const cycle = applyCommand(
          coordinator,
          input.turnId,
          "cycle-to-model",
          input.configurationGeneration,
        );
        if (!cycle.ok) {
          return {
            kind: "turn-error",
            error: cycle.error,
            iterations: iteration,
            results,
            turn: coordinator.get(input.turnId),
          };
        }

        const continued = await input.continueModel({
          turnId: input.turnId,
          iteration,
          results,
          signal: input.signal,
        });

        if (input.signal.aborted) {
          return settleAbort({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            abortAs: abortAs(),
            iterations: iteration,
            results,
            inFlightEffect: foldToolEffects(
              results.map((record) => effectOfToolOutcome(record.outcome)),
            ),
          });
        }

        if (continued.kind === "stop") {
          const current = coordinator.get(input.turnId);
          if (current?.status === "terminal") {
            return completedOutcome(iteration, results, current);
          }
          if (current?.phase === "awaiting-model") {
            const handling = applyCommand(
              coordinator,
              input.turnId,
              "begin-handling-model-event",
              input.configurationGeneration,
            );
            if (!handling.ok) {
              return {
                kind: "turn-error",
                error: handling.error,
                iterations: iteration,
                results,
                turn: coordinator.get(input.turnId),
              };
            }
          }
          return finishTurn({
            coordinator,
            turnId: input.turnId,
            configurationGeneration: input.configurationGeneration,
            iterations: iteration,
            results,
          });
        }

        if (fallback?.kind === "available") {
          const nextNames = continued.proposals.map((proposal) => proposal.name);
          const undeclared = nextNames.find((name) => !fallback.allowedToolNames.has(name));
          if (undeclared !== undefined) {
            return settleClassified({
              coordinator,
              turnId: input.turnId,
              configurationGeneration: input.configurationGeneration,
              iterations: iteration,
              results,
              classified: {
                kind: "unavailable",
                reason: `fallback-not-declared:${undeclared}`,
              },
            });
          }
          if (
            nextNames.length === 0 ||
            fallbackTransitions + nextNames.length > fallback.maximumTransitions
          ) {
            return settleClassified({
              coordinator,
              turnId: input.turnId,
              configurationGeneration: input.configurationGeneration,
              iterations: iteration,
              results,
              classified: { kind: "unavailable", reason: "fallback-transition-limit" },
            });
          }
          for (const source of fallback.fromToolNames) fallbackVisited.add(source);
          for (const target of nextNames) fallbackVisited.add(target);
          fallbackTransitions += nextNames.length;
        }

        const current = coordinator.get(input.turnId);
        if (current?.phase === "awaiting-model") {
          const handling = applyCommand(
            coordinator,
            input.turnId,
            "begin-handling-model-event",
            input.configurationGeneration,
          );
          if (!handling.ok) {
            return {
              kind: "turn-error",
              error: handling.error,
              iterations: iteration,
              results,
              turn: coordinator.get(input.turnId),
            };
          }
        }

        const executing = applyCommand(
          coordinator,
          input.turnId,
          "begin-executing-capability",
          input.configurationGeneration,
        );
        if (!executing.ok) {
          return {
            kind: "turn-error",
            error: executing.error,
            iterations: iteration,
            results,
            turn: coordinator.get(input.turnId),
          };
        }

        proposals = toProposals(continued.proposals);
      }
    },
  };
}

function normalizeLimits(partial: Partial<ToolCallLoopLimits> | undefined): ToolCallLoopLimits {
  const maxIterations = clamp(
    partial?.maxIterations ?? DEFAULT_TOOL_CALL_LOOP_LIMITS.maxIterations,
    1,
    MAX_TOOL_LOOP_ITERATIONS,
  );
  const maxConcurrentTools = clamp(
    partial?.maxConcurrentTools ?? DEFAULT_TOOL_CALL_LOOP_LIMITS.maxConcurrentTools,
    1,
    MAX_CONCURRENT_TOOLS,
  );
  const maxToolCallsPerIteration = clamp(
    partial?.maxToolCallsPerIteration ?? DEFAULT_TOOL_CALL_LOOP_LIMITS.maxToolCallsPerIteration,
    1,
    MAX_TOOL_CALLS_PER_ITERATION,
  );
  return { maxIterations, maxConcurrentTools, maxToolCallsPerIteration };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function toProposals(
  proposals: readonly ToolProposal[] | readonly AssembledToolProposal[],
): ToolProposal[] {
  return proposals.map((proposal) => ({
    toolCallId: proposal.toolCallId,
    name: proposal.name,
    arguments: proposal.arguments,
  }));
}

type ExplicitFallbackResolution =
  | {
      readonly kind: "available";
      readonly fromToolNames: readonly string[];
      readonly allowedToolNames: ReadonlySet<string>;
      readonly maximumTransitions: number;
    }
  | { readonly kind: "exhausted"; readonly reason: string };

function resolveExplicitFallback(
  records: readonly ToolInvocationRecord[],
  policy: ToolCallLoopOptions["fallbackPolicy"],
  visited: ReadonlySet<string>,
  transitionsMade: number,
  loopMaximum: number,
): ExplicitFallbackResolution {
  const fromToolNames = records
    .filter((record) => record.outcome.status === "unavailable")
    .map((record) => record.toolName);
  if (policy === undefined || fromToolNames.length === 0) {
    return { kind: "exhausted", reason: "no-declared-fallback" };
  }
  const maximumTransitions = Math.min(loopMaximum, Math.max(1, Math.trunc(policy.maxTransitions)));
  if (transitionsMade >= maximumTransitions) {
    return { kind: "exhausted", reason: "fallback-transition-limit" };
  }
  const declaredToolNames = policy.transitions
    .filter((transition) => fromToolNames.includes(transition.fromToolName))
    .flatMap((transition) => transition.toToolNames);
  if (declaredToolNames.length === 0) {
    return { kind: "exhausted", reason: "no-declared-fallback" };
  }
  const allowedToolNames = new Set(declaredToolNames.filter((name) => !visited.has(name)));
  if (allowedToolNames.size === 0) {
    return { kind: "exhausted", reason: "fallback-exhausted" };
  }
  return {
    kind: "available",
    fromToolNames: Object.freeze(fromToolNames),
    allowedToolNames,
    maximumTransitions,
  };
}

function applyCommand(
  coordinator: TurnCoordinator,
  turnId: TurnId,
  command:
    | "begin-executing-capability"
    | "cycle-to-model"
    | "begin-handling-model-event"
    | "begin-evaluating-completion"
    | "complete"
    | "fail"
    | "cancel"
    | "time-out"
    | "mark-uncertain",
  configurationGeneration: ConfigurationGeneration,
  effect?: EffectCertainty,
): { ok: true } | { ok: false; error: TurnCoordinatorError } {
  const result = coordinator.apply({
    turnId,
    command,
    configurationGeneration,
    ...(effect === undefined ? {} : { effect }),
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function executeBoundBatch(input: {
  readonly batch: readonly BoundToolInvocation[];
  readonly runner: ToolRunnerPort;
  readonly signal: AbortSignal;
  readonly maxConcurrent: number;
}): Promise<{
  readonly records: readonly ToolInvocationRecord[];
  readonly aborted: boolean;
}> {
  const { batch, runner, signal, maxConcurrent } = input;
  const records: ToolInvocationRecord[] = new Array(batch.length);
  let nextIndex = 0;
  let aborted = false;

  const workers = Array.from({ length: Math.min(maxConcurrent, batch.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batch.length) {
        return;
      }
      const bound = batch[index];
      if (bound === undefined) {
        return;
      }

      if (signal.aborted) {
        aborted = true;
        records[index] = recordFromOutcome(bound, {
          status: "cancelled",
          effect: bound.descriptor.effect === "observation" ? "none" : "uncertain",
        });
        continue;
      }

      const child = new AbortController();
      const onAbort = (): void => {
        child.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        child.abort();
      }

      try {
        const outcome = await runner.execute({
          invocationId: bound.invocationId,
          toolCallId: bound.proposal.toolCallId,
          toolName: bound.descriptor.name,
          capabilityId: bound.descriptor.id,
          version: bound.descriptor.version,
          effect: bound.descriptor.effect,
          input: bound.input,
          signal: child.signal,
        });
        if (signal.aborted) {
          aborted = true;
        }
        records[index] = recordFromOutcome(bound, outcome);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  });

  // Await every worker so cancellation never reports before in-flight cleanup.
  await Promise.all(workers);
  return { records, aborted: aborted || signal.aborted };
}

function recordFromOutcome(
  bound: BoundToolInvocation,
  outcome: ToolInvocationOutcome,
): ToolInvocationRecord {
  return {
    invocationId: bound.invocationId,
    toolCallId: bound.proposal.toolCallId,
    toolName: bound.descriptor.name,
    capabilityId: bound.descriptor.id,
    effectClass: bound.descriptor.effect,
    outcome,
  };
}

type ClassifiedStop =
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly effect: EffectCertainty }
  | { readonly kind: "partial"; readonly reason: string; readonly effect: EffectCertainty }
  | { readonly kind: "uncertain"; readonly recoveryHint: string };

function classifyPreTerminal(records: readonly ToolInvocationRecord[]): ClassifiedStop | null {
  for (const record of records) {
    const outcome = record.outcome;
    switch (outcome.status) {
      case "completed":
      case "cancelled":
      case "timed-out":
        break;
      case "denied":
        return { kind: "denied", reason: outcome.reason };
      case "malformed":
        return { kind: "malformed", reason: outcome.reason };
      case "unavailable":
        return { kind: "unavailable", reason: outcome.reason };
      case "failed":
        return { kind: "failed", reason: outcome.reason, effect: outcome.effect };
      case "partial":
        return {
          kind: "partial",
          reason: "tool returned partial output",
          effect: outcome.effect,
        };
      case "uncertain":
        return { kind: "uncertain", recoveryHint: outcome.recoveryHint };
      default:
        return assertNever(outcome, "unhandled tool outcome in classify");
    }
  }
  return null;
}

function settleBindFailure(input: {
  readonly coordinator: TurnCoordinator;
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly error: ToolBindError;
  readonly iterations: number;
  readonly results: readonly ToolInvocationRecord[];
}): ToolCallLoopOutcome {
  const { error } = input;
  switch (error.code) {
    case "queue-bound-exceeded":
      return {
        kind: "bound-exceeded",
        bound: "max-tool-calls-per-iteration",
        maximum: error.maximum,
        attempted: error.attempted,
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId),
      };
    case "unknown-tool": {
      const reason = `unknown tool: ${error.name}`;
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        "none",
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "unavailable",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        reason,
      };
    }
    case "malformed-input":
    case "duplicate-tool-call-id":
    case "invalid-tool-call-id":
    case "invalid-descriptor": {
      const reason = bindErrorReason(error);
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        "none",
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "malformed",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        reason,
        bindError: error,
      };
    }
    default:
      return assertNever(error, "unhandled bind error");
  }
}

function bindErrorReason(error: ToolBindError): string {
  switch (error.code) {
    case "malformed-input":
      return `malformed input for ${error.name}`;
    case "duplicate-tool-call-id":
      return `duplicate tool call id`;
    case "invalid-tool-call-id":
      return `invalid tool call id`;
    case "invalid-descriptor":
      return `invalid descriptor: ${error.reason}`;
    case "unknown-tool":
      return `unknown tool: ${error.name}`;
    case "queue-bound-exceeded":
      return `queue bound exceeded`;
    default:
      return assertNever(error, "unhandled bind error reason");
  }
}

function settleClassified(input: {
  readonly coordinator: TurnCoordinator;
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly iterations: number;
  readonly results: readonly ToolInvocationRecord[];
  readonly classified: ClassifiedStop;
}): ToolCallLoopOutcome {
  const { classified } = input;
  switch (classified.kind) {
    case "denied": {
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        "none",
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "denied",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        reason: classified.reason,
      };
    }
    case "malformed": {
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        "none",
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "malformed",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        reason: classified.reason,
        bindError: null,
      };
    }
    case "unavailable": {
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        "none",
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "unavailable",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        reason: classified.reason,
      };
    }
    case "failed": {
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        classified.effect,
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "failed",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        effect: classified.effect,
        reason: classified.reason,
      };
    }
    case "partial": {
      const failed = applyCommand(
        input.coordinator,
        input.turnId,
        "fail",
        input.configurationGeneration,
        classified.effect,
      );
      if (!failed.ok) {
        return {
          kind: "turn-error",
          error: failed.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "partial",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        effect: classified.effect,
        reason: classified.reason,
      };
    }
    case "uncertain": {
      const marked = applyCommand(
        input.coordinator,
        input.turnId,
        "mark-uncertain",
        input.configurationGeneration,
      );
      if (!marked.ok) {
        return {
          kind: "turn-error",
          error: marked.error,
          iterations: input.iterations,
          results: input.results,
          turn: input.coordinator.get(input.turnId),
        };
      }
      return {
        kind: "uncertain",
        iterations: input.iterations,
        results: input.results,
        turn: input.coordinator.get(input.turnId) as TurnSnapshot,
        recoveryHint: classified.recoveryHint,
      };
    }
    default:
      return assertNever(classified, "unhandled classified stop");
  }
}

function settleAbort(input: {
  readonly coordinator: TurnCoordinator;
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly abortAs: "cancel" | "timeout";
  readonly iterations: number;
  readonly results: readonly ToolInvocationRecord[];
  readonly inFlightEffect: EffectCertainty;
}): ToolCallLoopOutcome {
  const effect = foldToolEffects([
    input.inFlightEffect,
    ...input.results.map((record) => effectOfToolOutcome(record.outcome)),
  ]);

  const command = input.abortAs === "timeout" ? "time-out" : "cancel";
  const settled = applyCommand(
    input.coordinator,
    input.turnId,
    command,
    input.configurationGeneration,
    effect,
  );
  if (!settled.ok) {
    return {
      kind: "turn-error",
      error: settled.error,
      iterations: input.iterations,
      results: input.results,
      turn: input.coordinator.get(input.turnId),
    };
  }

  const turn = input.coordinator.get(input.turnId) as TurnSnapshot;
  // Cancel from executing-capability is forced to uncertain by the turn
  // machine (mutation may have begun). Mirror that in the loop outcome.
  if (turn.status === "terminal" && turn.outcome.kind === "uncertain") {
    return {
      kind: "uncertain",
      iterations: input.iterations,
      results: input.results,
      turn,
      recoveryHint: "cancelled during capability execution; inspect before retry",
    };
  }

  if (input.abortAs === "timeout") {
    return {
      kind: "timed-out",
      iterations: input.iterations,
      results: input.results,
      turn,
      effect,
    };
  }
  return {
    kind: "cancelled",
    iterations: input.iterations,
    results: input.results,
    turn,
    effect,
  };
}

function finishTurn(input: {
  readonly coordinator: TurnCoordinator;
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly iterations: number;
  readonly results: readonly ToolInvocationRecord[];
}): ToolCallLoopOutcome {
  const evaluating = applyCommand(
    input.coordinator,
    input.turnId,
    "begin-evaluating-completion",
    input.configurationGeneration,
  );
  if (!evaluating.ok) {
    return {
      kind: "turn-error",
      error: evaluating.error,
      iterations: input.iterations,
      results: input.results,
      turn: input.coordinator.get(input.turnId),
    };
  }

  const completed = applyCommand(
    input.coordinator,
    input.turnId,
    "complete",
    input.configurationGeneration,
  );
  if (!completed.ok) {
    return {
      kind: "turn-error",
      error: completed.error,
      iterations: input.iterations,
      results: input.results,
      turn: input.coordinator.get(input.turnId),
    };
  }

  const foldedEffect = foldToolEffects(
    input.results.map((record) => effectOfToolOutcome(record.outcome)),
  );

  return {
    kind: "completed",
    iterations: input.iterations,
    results: input.results,
    turn: input.coordinator.get(input.turnId) as TurnSnapshot,
    foldedEffect,
  };
}

function completedOutcome(
  iterations: number,
  results: readonly ToolInvocationRecord[],
  turn: TurnSnapshot,
): Extract<ToolCallLoopOutcome, { readonly kind: "completed" }> {
  return {
    kind: "completed",
    iterations,
    results,
    turn,
    foldedEffect: foldToolEffects(results.map((record) => effectOfToolOutcome(record.outcome))),
  };
}
