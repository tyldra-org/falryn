/**
 * Agent-loop consumer of normalized provider streams.
 *
 * Pulls adapter events through {@link normalizeProviderStream} (ordering /
 * sequence integrity from #36), applies bounded-queue backpressure, and drives
 * the #41 turn coordinator through `awaiting-model` → `handling-model-event`.
 *
 * Display-only text/reasoning deltas may coalesce under pressure. Semantic
 * facts (tool proposals, terminals, usage, start) never coalesce and reject
 * when the queue cannot admit them — there is no unbounded buffer path.
 *
 * Tool execution after proposals leave this consumer is owned by
 * `tool-call-loop` (#44). Does not apply retry/fallback (#45) or persist events
 * (#46). This module is the intentional model-service seam: it may import the
 * provider port and stream-assembly surface.
 */

import {
  assertNever,
  type ClockPort,
  type ConfigurationGeneration,
  duration,
  type EffectCertainty,
  type LimitKind,
  type QueueItemId,
  type QueueLimits,
  type QueueReport,
  type TurnId,
  type TurnSnapshot,
} from "../domain/index.ts";
import type { ProviderFailure } from "../providers/errors.ts";
import {
  type AssembledToolProposal,
  type NormalizedProviderEvent,
  normalizeProviderStream,
  type StreamAssemblySnapshot,
} from "../providers/index.ts";
import { createBoundedQueue } from "./bounded-queue.ts";
import type { TurnCoordinator, TurnCoordinatorError } from "./turn-coordinator.ts";

/** Default queue: coalesce display deltas; reject semantic overflow. */
export const DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS: QueueLimits = {
  maxItems: 8,
  maxBytes: 64 * 1024,
  maxItemAgeMs: duration(60_000),
  overflow: "coalesce",
};

export type ProviderStreamConsumerOptions = {
  readonly clock: ClockPort;
  readonly coordinator: TurnCoordinator;
  /**
   * Queue overflow policy. Defaults to coalesce (display) / reject (semantic).
   * Use `wait` to pause the producer until the consumer drains.
   */
  readonly queueLimits?: QueueLimits;
};

export type ConsumeProviderStreamInput = {
  readonly turnId: TurnId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Raw adapter events for one model attempt (pre-assembly). */
  readonly events: AsyncIterable<NormalizedProviderEvent>;
  readonly signal: AbortSignal;
  /**
   * How cooperative abort settles the turn when the signal fires before a
   * provider terminal. Defaults to `cancel`.
   */
  readonly abortAs?: "cancel" | "timeout";
};

export type ProviderStreamConsumeOutcome =
  | {
      readonly kind: "finished";
      readonly snapshot: StreamAssemblySnapshot;
      readonly finishReason: string;
      readonly toolProposals: readonly AssembledToolProposal[];
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "failed";
      readonly snapshot: StreamAssemblySnapshot;
      readonly failure: ProviderFailure;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "malformed";
      readonly snapshot: StreamAssemblySnapshot;
      readonly failure: ProviderFailure;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "cancelled";
      readonly snapshot: StreamAssemblySnapshot;
      readonly effect: EffectCertainty;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "timed-out";
      readonly snapshot: StreamAssemblySnapshot;
      readonly effect: EffectCertainty;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "partial";
      readonly snapshot: StreamAssemblySnapshot;
      readonly reason: "missing-terminal" | "stream-ended-early";
      readonly failure: ProviderFailure | null;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "backpressure-rejected";
      readonly snapshot: StreamAssemblySnapshot;
      readonly limit: LimitKind;
      readonly maximum: number;
      readonly observed: number;
      readonly turn: TurnSnapshot;
      readonly queueReport: QueueReport;
    }
  | {
      readonly kind: "turn-error";
      readonly error: TurnCoordinatorError;
      readonly snapshot: StreamAssemblySnapshot | null;
      readonly turn: TurnSnapshot | null;
      readonly queueReport: QueueReport | null;
    };

export type ProviderStreamConsumer = {
  consume(input: ConsumeProviderStreamInput): Promise<ProviderStreamConsumeOutcome>;
};

type QueuedEvent = {
  readonly event: NormalizedProviderEvent;
  readonly snapshot: StreamAssemblySnapshot;
};

function isDisplayOnly(kind: NormalizedProviderEvent["kind"]): boolean {
  return kind === "text-delta" || kind === "reasoning-delta";
}

function mergeKeyFor(event: NormalizedProviderEvent): string | null {
  switch (event.kind) {
    case "text-delta":
      return "provider-text-delta";
    case "reasoning-delta":
      return "provider-reasoning-delta";
    case "request-started":
    case "tool-call-delta":
    case "tool-proposal":
    case "usage":
    case "provider-metadata":
    case "finished":
    case "error":
      return null;
    default:
      return assertNever(event, "unhandled provider event kind for merge key");
  }
}

function approximateByteLength(event: NormalizedProviderEvent): number {
  switch (event.kind) {
    case "text-delta":
    case "reasoning-delta":
      return Math.max(1, event.text.length);
    case "tool-call-delta":
      return Math.max(1, event.argumentsFragment.length + (event.name?.length ?? 0));
    case "tool-proposal":
      return Math.max(1, event.argumentsJson.length + event.name.length);
    case "provider-metadata":
      return Math.max(1, JSON.stringify(event.entries).length);
    case "usage":
      return 32;
    case "request-started":
    case "finished":
    case "error":
      return 16;
    default:
      return assertNever(event, "unhandled provider event kind for byte length");
  }
}

function isMalformedFailure(failure: ProviderFailure): boolean {
  return failure.kind === "malformed-stream" || failure.kind === "adapter-defect";
}

function observedModelContent(snapshot: StreamAssemblySnapshot): boolean {
  return (
    snapshot.text.length > 0 || snapshot.reasoning.length > 0 || snapshot.toolProposals.length > 0
  );
}

function effectForAbort(snapshot: StreamAssemblySnapshot): EffectCertainty {
  return observedModelContent(snapshot) ? "partial" : "none";
}

function emptySnapshot(): StreamAssemblySnapshot {
  return {
    text: "",
    reasoning: "",
    toolProposals: [],
    usage: null,
    finishReason: null,
    diagnostics: [],
  };
}

export function createProviderStreamConsumer(
  options: ProviderStreamConsumerOptions,
): ProviderStreamConsumer {
  const { clock, coordinator } = options;
  const limits: QueueLimits = options.queueLimits ?? DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS;

  return {
    async consume(input) {
      const turn = coordinator.get(input.turnId);
      if (turn === null) {
        return {
          kind: "turn-error",
          error: { code: "turn-not-found", turnId: input.turnId },
          snapshot: null,
          turn: null,
          queueReport: null,
        };
      }

      if (turn.status === "terminal") {
        return {
          kind: "turn-error",
          error: {
            code: "already-terminal",
            command: "begin-awaiting-model",
            outcome: turn.outcome,
          },
          snapshot: null,
          turn,
          queueReport: null,
        };
      }

      if (turn.phase === "assembling-context") {
        const advanced = coordinator.apply({
          turnId: input.turnId,
          command: "begin-awaiting-model",
          configurationGeneration: input.configurationGeneration,
        });
        if (!advanced.ok) {
          return {
            kind: "turn-error",
            error: advanced.error,
            snapshot: null,
            turn: coordinator.get(input.turnId),
            queueReport: null,
          };
        }
      } else if (turn.phase !== "awaiting-model") {
        return {
          kind: "turn-error",
          error: {
            code: "illegal-transition",
            phase: turn.phase,
            command: "begin-awaiting-model",
            terminal: false,
          },
          snapshot: null,
          turn,
          queueReport: null,
        };
      }

      const queue = createBoundedQueue<QueuedEvent>({ clock, limits });
      let latestSnapshot = emptySnapshot();
      let handlingModel = false;
      let enqueueSequence = 0;

      const report = (): QueueReport => queue.report();

      const settleAbort = (
        snapshot: StreamAssemblySnapshot,
        as: "cancel" | "timeout",
      ): ProviderStreamConsumeOutcome => {
        const effect = effectForAbort(snapshot);
        const command = as === "timeout" ? "time-out" : "cancel";
        const settled = coordinator.apply({
          turnId: input.turnId,
          command,
          configurationGeneration: input.configurationGeneration,
          effect,
        });
        if (!settled.ok) {
          return {
            kind: "turn-error",
            error: settled.error,
            snapshot,
            turn: coordinator.get(input.turnId),
            queueReport: report(),
          };
        }
        return {
          kind: as === "timeout" ? "timed-out" : "cancelled",
          snapshot,
          effect,
          turn: settled.value.snapshot,
          queueReport: report(),
        };
      };

      const ensureHandling = (): ProviderStreamConsumeOutcome | null => {
        if (handlingModel) {
          return null;
        }
        const moved = coordinator.apply({
          turnId: input.turnId,
          command: "begin-handling-model-event",
          configurationGeneration: input.configurationGeneration,
        });
        if (!moved.ok) {
          return {
            kind: "turn-error",
            error: moved.error,
            snapshot: latestSnapshot,
            turn: coordinator.get(input.turnId),
            queueReport: report(),
          };
        }
        handlingModel = true;
        return null;
      };

      const settleFinished = (
        snapshot: StreamAssemblySnapshot,
        finishReason: string,
      ): ProviderStreamConsumeOutcome => {
        const handlingError = ensureHandling();
        if (handlingError !== null) {
          return handlingError;
        }

        // Tool proposals stop here — execution is #44.
        if (snapshot.toolProposals.length > 0) {
          return {
            kind: "finished",
            snapshot,
            finishReason,
            toolProposals: snapshot.toolProposals,
            turn: coordinator.get(input.turnId) as TurnSnapshot,
            queueReport: report(),
          };
        }

        const evaluating = coordinator.apply({
          turnId: input.turnId,
          command: "begin-evaluating-completion",
          configurationGeneration: input.configurationGeneration,
        });
        if (!evaluating.ok) {
          return {
            kind: "turn-error",
            error: evaluating.error,
            snapshot,
            turn: coordinator.get(input.turnId),
            queueReport: report(),
          };
        }
        const completed = coordinator.apply({
          turnId: input.turnId,
          command: "complete",
          configurationGeneration: input.configurationGeneration,
        });
        if (!completed.ok) {
          return {
            kind: "turn-error",
            error: completed.error,
            snapshot,
            turn: coordinator.get(input.turnId),
            queueReport: report(),
          };
        }
        return {
          kind: "finished",
          snapshot,
          finishReason,
          toolProposals: [],
          turn: completed.value.snapshot,
          queueReport: report(),
        };
      };

      const settleFailure = (
        snapshot: StreamAssemblySnapshot,
        failure: ProviderFailure,
      ): ProviderStreamConsumeOutcome => {
        const handlingError = ensureHandling();
        if (handlingError !== null) {
          return handlingError;
        }

        if (failure.kind === "cancellation") {
          return settleAbort(snapshot, "cancel");
        }
        if (failure.kind === "timeout") {
          return settleAbort(snapshot, "timeout");
        }

        const effect: EffectCertainty = observedModelContent(snapshot) ? "partial" : "none";
        const failed = coordinator.apply({
          turnId: input.turnId,
          command: "fail",
          configurationGeneration: input.configurationGeneration,
          effect,
        });
        if (!failed.ok) {
          return {
            kind: "turn-error",
            error: failed.error,
            snapshot,
            turn: coordinator.get(input.turnId),
            queueReport: report(),
          };
        }
        if (isMalformedFailure(failure)) {
          return {
            kind: "malformed",
            snapshot,
            failure,
            turn: failed.value.snapshot,
            queueReport: report(),
          };
        }
        return {
          kind: "failed",
          snapshot,
          failure,
          turn: failed.value.snapshot,
          queueReport: report(),
        };
      };

      const drainOne = (): ProviderStreamConsumeOutcome | "continue" | "empty" => {
        const item = queue.dequeue();
        if (item === null) {
          return "empty";
        }
        latestSnapshot = item.payload.snapshot;
        const handlingError = ensureHandling();
        if (handlingError !== null) {
          return handlingError;
        }
        return "continue";
      };

      const drainAvailable = (): ProviderStreamConsumeOutcome | null => {
        for (;;) {
          const step = drainOne();
          if (step === "empty") {
            return null;
          }
          if (step === "continue") {
            continue;
          }
          return step;
        }
      };

      try {
        const iterator = normalizeProviderStream(input.events);
        let next = await iterator.next();
        while (!next.done) {
          if (input.signal.aborted) {
            queue.drain();
            return settleAbort(latestSnapshot, input.abortAs ?? "cancel");
          }

          const { event, snapshot } = next.value;
          latestSnapshot = snapshot;
          enqueueSequence += 1;
          const displayOnly = isDisplayOnly(event.kind);
          const request = {
            id: `evt-${enqueueSequence}` as QueueItemId,
            byteLength: approximateByteLength(event),
            coalescable: displayOnly,
            mergeKey: mergeKeyFor(event),
            payload: { event, snapshot },
          };
          let enqueueOutcome = await queue.enqueue(request, input.signal);

          // Display-only traffic may fill the queue under coalesce. Before
          // failing a semantic fact, drain applied display so the fact can
          // admit when policy allows — never drop the semantic event silently.
          if (enqueueOutcome.kind === "rejected" && !displayOnly) {
            const drained = drainAvailable();
            if (drained !== null) {
              return drained;
            }
            enqueueOutcome = await queue.enqueue(request, input.signal);
          }

          switch (enqueueOutcome.kind) {
            case "accepted":
            case "coalesced":
            case "waited":
            case "spilled":
              break;
            case "cancelled":
              queue.drain();
              return settleAbort(latestSnapshot, input.abortAs ?? "cancel");
            case "rejected": {
              queue.drain();
              const handlingError = ensureHandling();
              if (handlingError !== null) {
                return handlingError;
              }
              const effect: EffectCertainty = observedModelContent(latestSnapshot)
                ? "partial"
                : "none";
              const failed = coordinator.apply({
                turnId: input.turnId,
                command: "fail",
                configurationGeneration: input.configurationGeneration,
                effect,
              });
              if (!failed.ok) {
                return {
                  kind: "turn-error",
                  error: failed.error,
                  snapshot: latestSnapshot,
                  turn: coordinator.get(input.turnId),
                  queueReport: report(),
                };
              }
              return {
                kind: "backpressure-rejected",
                snapshot: latestSnapshot,
                limit: enqueueOutcome.limit,
                maximum: enqueueOutcome.maximum,
                observed: enqueueOutcome.observed,
                turn: failed.value.snapshot,
                queueReport: report(),
              };
            }
            default:
              return assertNever(enqueueOutcome, "unhandled enqueue outcome");
          }

          next = await iterator.next();
        }

        // Apply buffered events in order after the producer stops (or after
        // coalesce replaced display-only slots). Snapshots on the queue may be
        // stale relative to latestSnapshot; prefer the assembly terminal below.
        const drainError = drainAvailable();
        if (drainError !== null) {
          return drainError;
        }
        latestSnapshot = next.value.snapshot;

        const terminal = next.value;
        switch (terminal.kind) {
          case "finished":
            return settleFinished(terminal.snapshot, terminal.finishReason);
          case "failed": {
            const missingTerminal = terminal.snapshot.diagnostics.some(
              (diagnostic) => diagnostic.code === "missing-terminal",
            );
            if (missingTerminal) {
              const handlingError = ensureHandling();
              if (handlingError !== null) {
                return handlingError;
              }
              const effect: EffectCertainty = observedModelContent(terminal.snapshot)
                ? "partial"
                : "none";
              const failed = coordinator.apply({
                turnId: input.turnId,
                command: "fail",
                configurationGeneration: input.configurationGeneration,
                effect,
              });
              if (!failed.ok) {
                return {
                  kind: "turn-error",
                  error: failed.error,
                  snapshot: terminal.snapshot,
                  turn: coordinator.get(input.turnId),
                  queueReport: report(),
                };
              }
              return {
                kind: "partial",
                snapshot: terminal.snapshot,
                reason: "missing-terminal",
                failure: terminal.failure,
                turn: failed.value.snapshot,
                queueReport: report(),
              };
            }
            return settleFailure(terminal.snapshot, terminal.failure);
          }
          default:
            return assertNever(terminal, "unhandled stream assembly terminal");
        }
      } finally {
        queue.drain();
      }
    },
  };
}
