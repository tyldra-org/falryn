/**
 * Session-scoped mid-turn classification over the turn coordinator (#611).
 *
 * Owns the follow-up queue and classification outcomes. Interrupt classification
 * records a semantic event and returns the existing cancellation intent — the
 * interruption policy / turn `cancel` command remain the ladder owners.
 */

import {
  applyFollowUpAsSteer,
  classifyMidTurnInput,
  describeMidTurnClassifyError,
  dropFollowUp,
  emptyFollowUpQueue,
  type FollowUpId,
  followUpId as followUpIdCodec,
  type MidTurnClassification,
  type MidTurnClassifyError,
  type MidTurnIntent,
  type MidTurnRequestSnapshot,
  type MidTurnSemanticEvent,
  type MidTurnSessionView,
  type ModelAttemptId,
  promoteFollowUp,
  refuseSecondInFlightTurn,
  type SessionId,
  type TurnId,
  type TurnSnapshot,
  takeHeadFollowUpForNextTurn,
} from "../domain/index.ts";
import type { InterruptionDecision, InterruptionPolicy } from "./interruption.ts";
import type { TurnCoordinator } from "./turn-coordinator.ts";

export type MidTurnInputService = {
  view(): MidTurnSessionView;
  events(): readonly MidTurnSemanticEvent[];
  setActiveAttempt(attemptId: ModelAttemptId | null): void;
  /** Sync active turn from the coordinator snapshot (or clear when terminal/missing). */
  syncFromTurn(snapshot: TurnSnapshot | null): void;
  classify(input: {
    readonly intent: MidTurnIntent | null;
    readonly request: MidTurnRequestSnapshot;
    readonly followUpId?: FollowUpId;
  }):
    | {
        readonly ok: true;
        readonly classification: MidTurnClassification;
        readonly events: readonly MidTurnSemanticEvent[];
        readonly interrupt: InterruptionDecision | null;
      }
    | { readonly ok: false; readonly error: MidTurnClassifyError };
  promote(
    followUpId: FollowUpId,
  ):
    | { readonly ok: true; readonly events: readonly MidTurnSemanticEvent[] }
    | { readonly ok: false; readonly error: MidTurnClassifyError };
  drop(
    followUpId: FollowUpId,
  ):
    | { readonly ok: true; readonly events: readonly MidTurnSemanticEvent[] }
    | { readonly ok: false; readonly error: MidTurnClassifyError };
  applyAsSteer(followUpId: FollowUpId):
    | {
        readonly ok: true;
        readonly steer: MidTurnRequestSnapshot;
        readonly events: readonly MidTurnSemanticEvent[];
      }
    | { readonly ok: false; readonly error: MidTurnClassifyError };
  /**
   * After the in-flight turn is terminal, start the head follow-up as the next
   * turn id. Refuses while a turn is still active.
   */
  startHeadFollowUp(nextTurnId: TurnId):
    | {
        readonly ok: true;
        readonly started: {
          readonly followUpId: FollowUpId;
          readonly request: MidTurnRequestSnapshot;
          readonly events: readonly MidTurnSemanticEvent[];
        } | null;
      }
    | { readonly ok: false; readonly error: MidTurnClassifyError };
  /** Guard before `TurnCoordinator.start` on this session. */
  assertCanStartTurn(): MidTurnClassifyError | null;
};

export type MidTurnInputServiceOptions = {
  readonly sessionId: SessionId;
  readonly coordinator: TurnCoordinator;
  readonly interruption: InterruptionPolicy;
  /** Supplies follow-up ids when the caller does not. */
  readonly nextFollowUpId?: () => FollowUpId;
};

let followUpSeq = 0;

function defaultFollowUpId(): FollowUpId {
  followUpSeq += 1;
  return followUpIdCodec.from(`follow-up-${followUpSeq}`);
}

export function createMidTurnInputService(
  options: MidTurnInputServiceOptions,
): MidTurnInputService {
  let session: MidTurnSessionView = {
    sessionId: options.sessionId,
    active: null,
    queue: emptyFollowUpQueue(options.sessionId),
  };
  const recorded: MidTurnSemanticEvent[] = [];
  const nextId = options.nextFollowUpId ?? defaultFollowUpId;

  const append = (events: readonly MidTurnSemanticEvent[]): void => {
    recorded.push(...events);
  };

  return {
    view() {
      return session;
    },

    events() {
      return recorded;
    },

    setActiveAttempt(attemptId) {
      if (session.active === null) {
        return;
      }
      session = {
        ...session,
        active: { ...session.active, attemptId },
      };
    },

    syncFromTurn(snapshot) {
      if (snapshot === null || snapshot.status === "terminal") {
        session = { ...session, active: null };
        return;
      }
      const attemptId =
        session.active?.turnId === snapshot.turnId ? session.active.attemptId : null;
      session = {
        ...session,
        active: { turnId: snapshot.turnId, attemptId },
      };
    },

    classify(input) {
      const followUpId = input.followUpId ?? nextId();
      const classified = classifyMidTurnInput({
        session,
        intent: input.intent,
        request: input.request,
        followUpId,
      });
      if (!classified.ok) {
        return classified;
      }

      session = classified.value.session;
      append(classified.value.events);

      if (classified.value.classification === "interrupt") {
        const decision = options.interruption.interrupt("interrupt");
        const turn = session.active?.turnId;
        if (turn !== undefined) {
          const snap = options.coordinator.get(turn);
          if (snap !== null && snap.status === "active") {
            options.coordinator.apply({
              turnId: turn,
              command: "cancel",
              configurationGeneration: snap.configurationGeneration,
            });
          }
          const after = options.coordinator.get(turn);
          if (after === null || after.status === "terminal") {
            session = { ...session, active: null };
          }
        }
        return {
          ok: true,
          classification: "interrupt",
          events: classified.value.events,
          interrupt: decision,
        };
      }

      return {
        ok: true,
        classification: classified.value.classification,
        events: classified.value.events,
        interrupt: null,
      };
    },

    promote(id) {
      const result = promoteFollowUp(session.queue, id);
      if (!result.ok) {
        return result;
      }
      session = { ...session, queue: result.value };
      append([result.event]);
      return { ok: true, events: [result.event] };
    },

    drop(id) {
      const result = dropFollowUp(session.queue, id);
      if (!result.ok) {
        return result;
      }
      session = { ...session, queue: result.value };
      append([result.event]);
      return { ok: true, events: [result.event] };
    },

    applyAsSteer(id) {
      const result = applyFollowUpAsSteer(session, id);
      if (!result.ok) {
        return result;
      }
      session = result.value.session;
      append(result.value.events);
      return {
        ok: true,
        steer: result.value.steer,
        events: result.value.events,
      };
    },

    startHeadFollowUp(nextTurnId) {
      const result = takeHeadFollowUpForNextTurn(session, nextTurnId);
      if (!result.ok) {
        return result;
      }
      if (result.value === null) {
        return { ok: true, started: null };
      }
      session = result.value.session;
      append([result.value.event]);
      return {
        ok: true,
        started: {
          followUpId: result.value.followUpId,
          request: result.value.request,
          events: [result.value.event],
        },
      };
    },

    assertCanStartTurn() {
      return refuseSecondInFlightTurn(session);
    },
  };
}

export { describeMidTurnClassifyError };
