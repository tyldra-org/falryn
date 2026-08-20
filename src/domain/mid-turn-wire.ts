/**
 * Wire form for mid-turn semantic events (#613).
 *
 * JSONL projections emit these through the CLI event record's `event` field.
 * They are not `RuntimeEvent` envelopes — mid-turn classification stays a
 * session-scoped semantic stream until a later schema raise folds it in.
 */

import type { FollowUpEntry, MidTurnSemanticEvent, MidTurnSessionView } from "./mid-turn-input.ts";

export function followUpQueueOrder(view: MidTurnSessionView): readonly string[] {
  return view.queue.entries.map((entry) => entry.followUpId);
}

export function followUpQueueOrderFromEntries(
  entries: readonly FollowUpEntry[],
): readonly string[] {
  return entries.map((entry) => entry.followUpId);
}

/** Canonical JSON object for one mid-turn semantic event, plus queue order. */
export function toWireMidTurnEvent(
  event: MidTurnSemanticEvent,
  queueOrder: readonly string[],
): Record<string, unknown> {
  const base = { queueOrder: [...queueOrder] };
  switch (event.kind) {
    case "mid-turn.classified":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        classification: event.classification,
        turnId: event.turnId,
        attemptId: event.attemptId,
        followUpId: event.followUpId,
        queueDepth: event.queueDepth,
      };
    case "mid-turn.steer-attached":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        turnId: event.turnId,
        attemptId: event.attemptId,
        request: {
          text: event.request.text,
          attachmentIds: [...event.request.attachmentIds],
          mentionIds: [...event.request.mentionIds],
        },
      };
    case "mid-turn.follow-up-queued":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        followUpId: event.followUpId,
        queueDepth: event.queueDepth,
        queueTextUnits: event.queueTextUnits,
      };
    case "mid-turn.follow-up-promoted":
    case "mid-turn.follow-up-dropped":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        followUpId: event.followUpId,
        queueDepth: event.queueDepth,
      };
    case "mid-turn.follow-up-started":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        followUpId: event.followUpId,
        turnId: event.turnId,
        remainingQueueDepth: event.remainingQueueDepth,
      };
    case "mid-turn.interrupt-requested":
      return {
        ...base,
        kind: event.kind,
        sessionId: event.sessionId,
        turnId: event.turnId,
        queueDepth: event.queueDepth,
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
