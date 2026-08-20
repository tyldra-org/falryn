/**
 * Mid-turn user-input classification (#611).
 *
 * While a turn is active, a subsequent user message is exactly one of steer,
 * follow-up, or interrupt. Pure: no coordinator, journal, or interruption
 * policy. Those attach outcomes through the application seam.
 */

import type { FollowUpId, ModelAttemptId, SessionId, TurnId } from "./identity.ts";
import { MAX_FOLLOW_UP_QUEUE_ENTRIES, MAX_FOLLOW_UP_QUEUE_TEXT_UNITS } from "./limits.ts";
import { assertNever } from "./result.ts";

export const MID_TURN_CLASSIFICATIONS = ["steer", "follow-up", "interrupt"] as const;
export type MidTurnClassification = (typeof MID_TURN_CLASSIFICATIONS)[number];

/** How the caller intends to classify submit-while-active. */
export const MID_TURN_INTENTS = ["steer", "follow-up", "interrupt"] as const;
export type MidTurnIntent = (typeof MID_TURN_INTENTS)[number];

/**
 * One user request snapshot that can attach as a steer or wait as a follow-up.
 *
 * Attachments and mentions stay opaque strings here — TUI/CLI children own
 * richer descriptors. Text length counts toward the queue byte ceiling.
 */
export type MidTurnRequestSnapshot = {
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly mentionIds: readonly string[];
};

export type FollowUpEntry = {
  readonly followUpId: FollowUpId;
  readonly sessionId: SessionId;
  readonly request: MidTurnRequestSnapshot;
  /** Monotonic enqueue order within the session queue. */
  readonly order: number;
};

export type FollowUpQueue = {
  readonly sessionId: SessionId;
  readonly entries: readonly FollowUpEntry[];
};

export type ActiveTurnTarget = {
  readonly turnId: TurnId;
  /** Current model attempt when known; null before the first attempt starts. */
  readonly attemptId: ModelAttemptId | null;
};

export type MidTurnSessionView = {
  readonly sessionId: SessionId;
  /** The single in-flight turn, or null when the session is idle. */
  readonly active: ActiveTurnTarget | null;
  readonly queue: FollowUpQueue;
};

export type MidTurnSemanticEvent =
  | {
      readonly kind: "mid-turn.classified";
      readonly sessionId: SessionId;
      readonly classification: MidTurnClassification;
      readonly turnId: TurnId | null;
      readonly attemptId: ModelAttemptId | null;
      readonly followUpId: FollowUpId | null;
      readonly queueDepth: number;
    }
  | {
      readonly kind: "mid-turn.steer-attached";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly attemptId: ModelAttemptId | null;
      readonly request: MidTurnRequestSnapshot;
    }
  | {
      readonly kind: "mid-turn.follow-up-queued";
      readonly sessionId: SessionId;
      readonly followUpId: FollowUpId;
      readonly queueDepth: number;
      readonly queueTextUnits: number;
    }
  | {
      readonly kind: "mid-turn.follow-up-promoted";
      readonly sessionId: SessionId;
      readonly followUpId: FollowUpId;
      readonly queueDepth: number;
    }
  | {
      readonly kind: "mid-turn.follow-up-dropped";
      readonly sessionId: SessionId;
      readonly followUpId: FollowUpId;
      readonly queueDepth: number;
    }
  | {
      readonly kind: "mid-turn.follow-up-started";
      readonly sessionId: SessionId;
      readonly followUpId: FollowUpId;
      readonly turnId: TurnId;
      readonly remainingQueueDepth: number;
    }
  | {
      readonly kind: "mid-turn.interrupt-requested";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly queueDepth: number;
    };

export type MidTurnClassifyError =
  | { readonly code: "idle"; readonly reason: string }
  | { readonly code: "ambiguous-intent"; readonly reason: string }
  | { readonly code: "second-turn-refused"; readonly reason: string }
  | { readonly code: "queue-full"; readonly reason: string; readonly limit: "entries" | "text" }
  | { readonly code: "follow-up-missing"; readonly followUpId: FollowUpId }
  | { readonly code: "empty-request"; readonly reason: string };

export type MidTurnClassifyOk = {
  readonly classification: MidTurnClassification;
  readonly session: MidTurnSessionView;
  readonly events: readonly MidTurnSemanticEvent[];
  /** Present when classification is follow-up. */
  readonly followUpId: FollowUpId | null;
  /** Present when classification is steer. */
  readonly steer: MidTurnRequestSnapshot | null;
};

export function emptyFollowUpQueue(sessionId: SessionId): FollowUpQueue {
  return { sessionId, entries: [] };
}

export function followUpQueueTextUnits(queue: FollowUpQueue): number {
  return queue.entries.reduce((sum, entry) => sum + entry.request.text.length, 0);
}

export function describeMidTurnClassifyError(error: MidTurnClassifyError): string {
  switch (error.code) {
    case "idle":
      return error.reason;
    case "ambiguous-intent":
      return error.reason;
    case "second-turn-refused":
      return error.reason;
    case "queue-full":
      return error.reason;
    case "follow-up-missing":
      return `follow-up ${error.followUpId} is not in the queue`;
    case "empty-request":
      return error.reason;
    default:
      return assertNever(error, "unhandled mid-turn classify error");
  }
}

/**
 * Classify a subsequent user message while a turn may be active.
 *
 * Intent is required and explicit — keystrokes alone never steer. Interrupt
 * does not need a request body. Steer and follow-up refuse an empty text with
 * no attachments or mentions.
 */
export function classifyMidTurnInput(input: {
  readonly session: MidTurnSessionView;
  readonly intent: MidTurnIntent | null;
  readonly request: MidTurnRequestSnapshot;
  readonly followUpId: FollowUpId;
}):
  | { readonly ok: true; readonly value: MidTurnClassifyOk }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  if (input.intent === null) {
    return {
      ok: false,
      error: {
        code: "ambiguous-intent",
        reason: "mid-turn submit needs an explicit steer, follow-up, or interrupt intent",
      },
    };
  }

  const { session, intent, request, followUpId } = input;

  if (intent === "interrupt") {
    if (session.active === null) {
      return {
        ok: false,
        error: { code: "idle", reason: "no in-flight turn to interrupt" },
      };
    }
    const events: MidTurnSemanticEvent[] = [
      {
        kind: "mid-turn.classified",
        sessionId: session.sessionId,
        classification: "interrupt",
        turnId: session.active.turnId,
        attemptId: session.active.attemptId,
        followUpId: null,
        queueDepth: session.queue.entries.length,
      },
      {
        kind: "mid-turn.interrupt-requested",
        sessionId: session.sessionId,
        turnId: session.active.turnId,
        queueDepth: session.queue.entries.length,
      },
    ];
    return {
      ok: true,
      value: {
        classification: "interrupt",
        session,
        events,
        followUpId: null,
        steer: null,
      },
    };
  }

  if (
    request.text.trim() === "" &&
    request.attachmentIds.length === 0 &&
    request.mentionIds.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "empty-request",
        reason: "steer and follow-up need text, an attachment, or a mention",
      },
    };
  }

  if (session.active === null) {
    return {
      ok: false,
      error: {
        code: "idle",
        reason: "no in-flight turn; start a turn instead of classifying mid-turn input",
      },
    };
  }

  if (intent === "steer") {
    const events: MidTurnSemanticEvent[] = [
      {
        kind: "mid-turn.classified",
        sessionId: session.sessionId,
        classification: "steer",
        turnId: session.active.turnId,
        attemptId: session.active.attemptId,
        followUpId: null,
        queueDepth: session.queue.entries.length,
      },
      {
        kind: "mid-turn.steer-attached",
        sessionId: session.sessionId,
        turnId: session.active.turnId,
        attemptId: session.active.attemptId,
        request,
      },
    ];
    return {
      ok: true,
      value: {
        classification: "steer",
        session,
        events,
        followUpId: null,
        steer: request,
      },
    };
  }

  // follow-up
  const queued = enqueueFollowUp({
    queue: session.queue,
    followUpId,
    request,
  });
  if (!queued.ok) {
    return queued;
  }

  const nextSession: MidTurnSessionView = {
    ...session,
    queue: queued.value,
  };
  const events: MidTurnSemanticEvent[] = [
    {
      kind: "mid-turn.classified",
      sessionId: session.sessionId,
      classification: "follow-up",
      turnId: session.active.turnId,
      attemptId: session.active.attemptId,
      followUpId,
      queueDepth: nextSession.queue.entries.length,
    },
    {
      kind: "mid-turn.follow-up-queued",
      sessionId: session.sessionId,
      followUpId,
      queueDepth: nextSession.queue.entries.length,
      queueTextUnits: followUpQueueTextUnits(nextSession.queue),
    },
  ];
  return {
    ok: true,
    value: {
      classification: "follow-up",
      session: nextSession,
      events,
      followUpId,
      steer: null,
    },
  };
}

/**
 * Refuse starting a second concurrent turn when one is already active.
 *
 * Follow-ups wait; they never become a parallel in-flight turn.
 */
export function refuseSecondInFlightTurn(session: MidTurnSessionView): MidTurnClassifyError | null {
  if (session.active === null) {
    return null;
  }
  return {
    code: "second-turn-refused",
    reason: "a turn is already in flight on this session; queue a follow-up instead",
  };
}

export function enqueueFollowUp(input: {
  readonly queue: FollowUpQueue;
  readonly followUpId: FollowUpId;
  readonly request: MidTurnRequestSnapshot;
}):
  | { readonly ok: true; readonly value: FollowUpQueue }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  if (input.queue.entries.length >= MAX_FOLLOW_UP_QUEUE_ENTRIES) {
    return {
      ok: false,
      error: {
        code: "queue-full",
        limit: "entries",
        reason: `follow-up queue already holds ${MAX_FOLLOW_UP_QUEUE_ENTRIES} entries`,
      },
    };
  }
  const nextText = followUpQueueTextUnits(input.queue) + input.request.text.length;
  if (nextText > MAX_FOLLOW_UP_QUEUE_TEXT_UNITS) {
    return {
      ok: false,
      error: {
        code: "queue-full",
        limit: "text",
        reason: `follow-up queue would exceed ${MAX_FOLLOW_UP_QUEUE_TEXT_UNITS} text units`,
      },
    };
  }
  const order =
    input.queue.entries.length === 0
      ? 1
      : Math.max(...input.queue.entries.map((entry) => entry.order)) + 1;
  const entry: FollowUpEntry = {
    followUpId: input.followUpId,
    sessionId: input.queue.sessionId,
    request: input.request,
    order,
  };
  return {
    ok: true,
    value: { sessionId: input.queue.sessionId, entries: [...input.queue.entries, entry] },
  };
}

export function promoteFollowUp(
  queue: FollowUpQueue,
  followUpId: FollowUpId,
):
  | {
      readonly ok: true;
      readonly value: FollowUpQueue;
      readonly event: MidTurnSemanticEvent;
    }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  const index = queue.entries.findIndex((entry) => entry.followUpId === followUpId);
  if (index < 0) {
    return { ok: false, error: { code: "follow-up-missing", followUpId } };
  }
  if (index === 0) {
    return {
      ok: true,
      value: queue,
      event: {
        kind: "mid-turn.follow-up-promoted",
        sessionId: queue.sessionId,
        followUpId,
        queueDepth: queue.entries.length,
      },
    };
  }
  const selected = queue.entries[index];
  if (selected === undefined) {
    return { ok: false, error: { code: "follow-up-missing", followUpId } };
  }
  const rest = queue.entries.filter((_, i) => i !== index);
  const next: FollowUpQueue = {
    sessionId: queue.sessionId,
    entries: [selected, ...rest],
  };
  return {
    ok: true,
    value: next,
    event: {
      kind: "mid-turn.follow-up-promoted",
      sessionId: queue.sessionId,
      followUpId,
      queueDepth: next.entries.length,
    },
  };
}

export function dropFollowUp(
  queue: FollowUpQueue,
  followUpId: FollowUpId,
):
  | {
      readonly ok: true;
      readonly value: FollowUpQueue;
      readonly event: MidTurnSemanticEvent;
    }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  const nextEntries = queue.entries.filter((entry) => entry.followUpId !== followUpId);
  if (nextEntries.length === queue.entries.length) {
    return { ok: false, error: { code: "follow-up-missing", followUpId } };
  }
  const next: FollowUpQueue = { sessionId: queue.sessionId, entries: nextEntries };
  return {
    ok: true,
    value: next,
    event: {
      kind: "mid-turn.follow-up-dropped",
      sessionId: queue.sessionId,
      followUpId,
      queueDepth: next.entries.length,
    },
  };
}

/**
 * Detach a queued entry and return it as a steer snapshot for the in-flight attempt.
 */
export function applyFollowUpAsSteer(
  session: MidTurnSessionView,
  followUpId: FollowUpId,
):
  | {
      readonly ok: true;
      readonly value: {
        readonly session: MidTurnSessionView;
        readonly steer: MidTurnRequestSnapshot;
        readonly events: readonly MidTurnSemanticEvent[];
      };
    }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  if (session.active === null) {
    return {
      ok: false,
      error: { code: "idle", reason: "apply-as-steer needs an in-flight turn" },
    };
  }
  const dropped = dropFollowUp(session.queue, followUpId);
  if (!dropped.ok) {
    return dropped;
  }
  const entry = session.queue.entries.find((item) => item.followUpId === followUpId);
  if (entry === undefined) {
    return { ok: false, error: { code: "follow-up-missing", followUpId } };
  }
  const nextSession: MidTurnSessionView = { ...session, queue: dropped.value };
  return {
    ok: true,
    value: {
      session: nextSession,
      steer: entry.request,
      events: [
        dropped.event,
        {
          kind: "mid-turn.steer-attached",
          sessionId: session.sessionId,
          turnId: session.active.turnId,
          attemptId: session.active.attemptId,
          request: entry.request,
        },
      ],
    },
  };
}

/**
 * Take the head follow-up once the session is idle (current turn terminal).
 *
 * Returns null when the queue is empty. Refuses while a turn is still active —
 * callers must interrupt or wait for terminal settlement first.
 */
export function takeHeadFollowUpForNextTurn(
  session: MidTurnSessionView,
  nextTurnId: TurnId,
):
  | {
      readonly ok: true;
      readonly value: {
        readonly session: MidTurnSessionView;
        readonly followUpId: FollowUpId;
        readonly request: MidTurnRequestSnapshot;
        readonly event: MidTurnSemanticEvent;
      } | null;
    }
  | { readonly ok: false; readonly error: MidTurnClassifyError } {
  if (session.active !== null) {
    return {
      ok: false,
      error: refuseSecondInFlightTurn(session) ?? {
        code: "second-turn-refused",
        reason: "a turn is already in flight on this session; queue a follow-up instead",
      },
    };
  }
  const head = session.queue.entries[0];
  if (head === undefined) {
    return { ok: true, value: null };
  }
  const remaining = session.queue.entries.slice(1);
  const nextSession: MidTurnSessionView = {
    sessionId: session.sessionId,
    active: { turnId: nextTurnId, attemptId: null },
    queue: { sessionId: session.sessionId, entries: remaining },
  };
  return {
    ok: true,
    value: {
      session: nextSession,
      followUpId: head.followUpId,
      request: head.request,
      event: {
        kind: "mid-turn.follow-up-started",
        sessionId: session.sessionId,
        followUpId: head.followUpId,
        turnId: nextTurnId,
        remainingQueueDepth: remaining.length,
      },
    },
  };
}
