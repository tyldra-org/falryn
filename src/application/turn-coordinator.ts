/**
 * In-memory turn coordinator over the turn state machine.
 *
 * Progresses one request through the named phases without composing prompts,
 * consuming provider streams, executing tools, or persisting events — those
 * belong to later #40 children. What this owns is exhaustive phase legality and
 * terminal settlement, including recovery under a new runtime generation.
 */

import {
  applyTurnTransition,
  type ConfigurationGeneration,
  createTurnSnapshot,
  type EffectCertainty,
  type EventId,
  type SessionId,
  type TerminalOutcome,
  type TraceId,
  type TurnCommand,
  type TurnId,
  type TurnObservation,
  type TurnSnapshot,
  type TurnTransitionError,
  type WorkspaceId,
} from "../domain/index.ts";

export type TurnCoordinatorError =
  | TurnTransitionError
  | { readonly code: "turn-not-found"; readonly turnId: TurnId }
  | { readonly code: "turn-already-exists"; readonly turnId: TurnId };

export type TurnCoordinatorResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: TurnCoordinatorError };

export type StartTurnInput = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
};

export type TurnCommandInput = {
  readonly turnId: TurnId;
  readonly command: TurnCommand;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly causationEventId?: EventId | null;
  readonly effect?: EffectCertainty;
  readonly recoveryGeneration?: ConfigurationGeneration;
};

export type TurnCoordinator = {
  start(input: StartTurnInput): TurnCoordinatorResult<TurnSnapshot>;
  apply(input: TurnCommandInput): TurnCoordinatorResult<{
    readonly snapshot: TurnSnapshot;
    readonly observation: TurnObservation;
  }>;
  get(turnId: TurnId): TurnSnapshot | null;
  observations(turnId: TurnId): readonly TurnObservation[];
  turns(): readonly TurnSnapshot[];
  /** Terminal outcomes observed for a turn, in settlement order. */
  terminals(turnId: TurnId): readonly TerminalOutcome[];
};

export function createTurnCoordinator(): TurnCoordinator {
  const snapshots = new Map<TurnId, TurnSnapshot>();
  const history = new Map<TurnId, TurnObservation[]>();

  return {
    start(input) {
      if (snapshots.has(input.turnId)) {
        return {
          ok: false,
          error: { code: "turn-already-exists", turnId: input.turnId },
        };
      }
      const snapshot = createTurnSnapshot(input);
      snapshots.set(input.turnId, snapshot);
      history.set(input.turnId, []);
      return { ok: true, value: snapshot };
    },

    apply(input) {
      const current = snapshots.get(input.turnId);
      if (current === undefined) {
        return {
          ok: false,
          error: { code: "turn-not-found", turnId: input.turnId },
        };
      }

      const result = applyTurnTransition({
        snapshot: current,
        command: input.command,
        configurationGeneration: input.configurationGeneration,
        ...(input.causationEventId === undefined
          ? {}
          : { causationEventId: input.causationEventId }),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        ...(input.recoveryGeneration === undefined
          ? {}
          : { recoveryGeneration: input.recoveryGeneration }),
      });

      if (result.kind === "rejected") {
        return { ok: false, error: result.error };
      }

      snapshots.set(input.turnId, result.snapshot);
      const prior = history.get(input.turnId) ?? [];
      history.set(input.turnId, [...prior, result.observation]);
      return {
        ok: true,
        value: { snapshot: result.snapshot, observation: result.observation },
      };
    },

    get(turnId) {
      return snapshots.get(turnId) ?? null;
    },

    observations(turnId) {
      return history.get(turnId) ?? [];
    },

    turns() {
      return [...snapshots.values()];
    },

    terminals(turnId) {
      return (history.get(turnId) ?? [])
        .filter((observation) => observation.terminal && observation.outcome !== null)
        .map((observation) => observation.outcome as TerminalOutcome);
    },
  };
}
