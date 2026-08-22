/**
 * Persist and replay turn lifecycle events through the existing event store.
 *
 * Owns append sequencing and typed replay outcomes. Does not execute tools or
 * send provider requests — replay rebuilds views from recorded facts only.
 * Wire callers (attempt policy, tool loop) inject this journal; the journal
 * never reaches back into those runners.
 */

import {
  type AppendReceipt,
  buildTurnLifecycleEvent,
  type ClockPort,
  classifyTurnReplay,
  type EventStoreError,
  type EventStorePort,
  FIRST_SEQUENCE,
  MAX_STREAM_READ_LIMIT,
  nextSequence,
  type ReplayedTurn,
  type ReplayReport,
  type RuntimeEvent,
  type Sequence,
  type SessionCorrelation,
  type StreamId,
  type TurnId,
  type TurnLifecycleFact,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";

export type TurnEventJournalOptions = {
  readonly eventStore: EventStorePort;
  readonly clock: ClockPort;
  readonly streamId: StreamId;
  /** Session correlation retained for callers that compose facts. */
  readonly correlation: SessionCorrelation;
  /**
   * Soft cap on events one replay read gathers. Hitting it yields `partial`
   * rather than pretending the stream ended. Defaults to the store read limit.
   */
  readonly maxEvents?: number;
};

export type PersistTurnEventsOutcome =
  | {
      readonly kind: "persisted";
      readonly events: readonly RuntimeEvent[];
      readonly receipts: readonly AppendReceipt[];
    }
  | {
      readonly kind: "cancelled";
      readonly events: readonly RuntimeEvent[];
      readonly receipts: readonly AppendReceipt[];
    }
  | {
      readonly kind: "store-error";
      readonly error: EventStoreError;
      readonly events: readonly RuntimeEvent[];
      readonly receipts: readonly AppendReceipt[];
    };

export type ReplayTurnEventsOutcome =
  | {
      readonly kind: "rebuilt";
      readonly turns: readonly ReplayedTurn[];
      readonly events: readonly RuntimeEvent[];
      readonly report: ReplayReport;
      readonly truncated: false;
    }
  | {
      readonly kind: "empty";
      readonly streamId: StreamId;
      readonly events: readonly [];
    }
  | {
      readonly kind: "turn-missing";
      readonly turnId: TurnId;
      readonly streamId: StreamId;
      readonly events: readonly RuntimeEvent[];
      readonly truncated: boolean;
    }
  | {
      readonly kind: "corrupt";
      readonly streamId: StreamId;
      readonly turns: readonly ReplayedTurn[];
      readonly events: readonly RuntimeEvent[];
      readonly report: ReplayReport;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "partial";
      readonly turns: readonly ReplayedTurn[];
      readonly events: readonly RuntimeEvent[];
      readonly report: ReplayReport;
      readonly truncated: true;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "store-error"; readonly error: EventStoreError };

export type TurnEventJournal = {
  /**
   * Appends lifecycle facts in order. Duplicate idempotency keys are receipts,
   * not failures — retries never create a second effect record.
   */
  persist(
    facts: readonly TurnLifecycleFact[],
    signal?: AbortSignal,
  ): Promise<PersistTurnEventsOutcome>;

  /** Rebuilds every turn in the stream from stored events. */
  replay(signal?: AbortSignal): Promise<ReplayTurnEventsOutcome>;

  /** Rebuilds one turn; missing turns are typed, not invented. */
  replayTurn(turnId: TurnId, signal?: AbortSignal): Promise<ReplayTurnEventsOutcome>;
};

/**
 * Narrow port attempt policy and other loop owners depend on so they never
 * import the store adapter shape.
 */
export type TurnEventJournalPort = Pick<TurnEventJournal, "persist">;

export function createTurnEventJournal(options: TurnEventJournalOptions): TurnEventJournal {
  let next: Sequence | null = null;
  const maxEvents = options.maxEvents ?? MAX_STREAM_READ_LIMIT;

  function aborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
  }

  type ClassifiedStream =
    | Extract<ReplayTurnEventsOutcome, { kind: "rebuilt" }>
    | Extract<ReplayTurnEventsOutcome, { kind: "empty" }>
    | Extract<ReplayTurnEventsOutcome, { kind: "corrupt" }>
    | Extract<ReplayTurnEventsOutcome, { kind: "partial" }>;

  async function discoverNextSequence(
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly next: Sequence }
    | { readonly ok: false; readonly error: EventStoreError }
    | { readonly ok: false; readonly cancelled: true }
  > {
    if (aborted(signal)) {
      return { ok: false, cancelled: true };
    }
    if (next !== null) {
      return { ok: true, next };
    }

    let afterSequence: Sequence | null = null;
    let last: Sequence | null = null;
    for (;;) {
      if (aborted(signal)) {
        return { ok: false, cancelled: true };
      }
      const page = await options.eventStore.readFrom(
        { streamId: options.streamId, afterSequence },
        MAX_STREAM_READ_LIMIT,
        signal,
      );
      if (!page.ok) {
        return { ok: false, error: page.error };
      }
      if (page.value.length === 0) {
        break;
      }
      const tail = page.value[page.value.length - 1];
      if (tail === undefined) {
        break;
      }
      last = tail.sequence;
      afterSequence = last;
      if (page.value.length < MAX_STREAM_READ_LIMIT) {
        break;
      }
    }

    next = last === null ? FIRST_SEQUENCE : nextSequence(last);
    return { ok: true, next };
  }

  async function readAllEvents(
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly events: readonly RuntimeEvent[]; readonly truncated: boolean }
    | { readonly ok: false; readonly error: EventStoreError }
    | { readonly ok: false; readonly cancelled: true }
  > {
    if (aborted(signal)) {
      return { ok: false, cancelled: true };
    }

    const events: RuntimeEvent[] = [];
    let afterSequence: Sequence | null = null;
    let truncated = false;

    for (;;) {
      if (aborted(signal)) {
        return { ok: false, cancelled: true };
      }
      const remaining = maxEvents - events.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const pageLimit = Math.min(MAX_STREAM_READ_LIMIT, remaining);
      const page = await options.eventStore.readFrom(
        { streamId: options.streamId, afterSequence },
        pageLimit,
        signal,
      );
      if (!page.ok) {
        return { ok: false, error: page.error };
      }
      if (page.value.length === 0) {
        break;
      }
      events.push(...page.value);
      const tail = page.value[page.value.length - 1];
      if (tail === undefined) {
        break;
      }
      afterSequence = tail.sequence;
      if (page.value.length < pageLimit) {
        break;
      }
      if (events.length >= maxEvents) {
        const peek = await options.eventStore.readFrom(
          { streamId: options.streamId, afterSequence },
          1,
          signal,
        );
        if (!peek.ok) {
          return { ok: false, error: peek.error };
        }
        truncated = peek.value.length > 0;
        break;
      }
    }

    return { ok: true, events, truncated };
  }

  function classifyRead(events: readonly RuntimeEvent[], truncated: boolean): ClassifiedStream {
    const classified = classifyTurnReplay(events);
    switch (classified.kind) {
      case "empty":
        return { kind: "empty", streamId: options.streamId, events: [] };
      case "corrupt":
        return {
          kind: "corrupt",
          streamId: options.streamId,
          turns: classified.reduction.turns,
          events,
          report: classified.report,
          truncated,
        };
      case "rebuilt":
        if (truncated) {
          return {
            kind: "partial",
            turns: classified.reduction.turns,
            events,
            report: classified.report,
            truncated: true,
          };
        }
        return {
          kind: "rebuilt",
          turns: classified.reduction.turns,
          events,
          report: classified.report,
          truncated: false,
        };
      default: {
        const _exhaustive: never = classified;
        return _exhaustive;
      }
    }
  }

  return {
    async persist(facts, signal) {
      const events: RuntimeEvent[] = [];
      const receipts: AppendReceipt[] = [];
      if (facts.length === 0) {
        return { kind: "persisted", events, receipts };
      }

      const discovered = await discoverNextSequence(signal);
      if (!discovered.ok) {
        if ("cancelled" in discovered) {
          return { kind: "cancelled", events, receipts };
        }
        return { kind: "store-error", error: discovered.error, events, receipts };
      }

      let sequence = discovered.next;
      for (const fact of facts) {
        if (aborted(signal)) {
          return { kind: "cancelled", events, receipts };
        }
        const event = buildTurnLifecycleEvent({
          fact,
          streamId: options.streamId,
          sequence,
          occurredAt: timestampFromEpochMilliseconds(options.clock.now()),
        });
        const appended = await options.eventStore.append(event, signal);
        if (!appended.ok) {
          return { kind: "store-error", error: appended.error, events, receipts };
        }
        events.push(event);
        receipts.push(appended.value);
        if (appended.value.kind === "appended") {
          sequence = nextSequence(sequence);
          next = sequence;
        } else {
          sequence = nextSequence(appended.value.sequence);
          next = sequence;
        }
      }

      return { kind: "persisted", events, receipts };
    },

    async replay(signal) {
      const read = await readAllEvents(signal);
      if (!read.ok) {
        if ("cancelled" in read) {
          return { kind: "cancelled" };
        }
        return { kind: "store-error", error: read.error };
      }
      return classifyRead(read.events, read.truncated);
    },

    async replayTurn(turnId, signal) {
      const read = await readAllEvents(signal);
      if (!read.ok) {
        if ("cancelled" in read) {
          return { kind: "cancelled" };
        }
        return { kind: "store-error", error: read.error };
      }

      const classified = classifyRead(read.events, read.truncated);
      if (classified.kind === "empty") {
        return {
          kind: "turn-missing",
          turnId,
          streamId: options.streamId,
          events: [],
          truncated: false,
        };
      }

      const turn = classified.turns.find((entry) => entry.turnId === turnId);
      if (turn === undefined) {
        return {
          kind: "turn-missing",
          turnId,
          streamId: options.streamId,
          events: classified.events,
          truncated: classified.truncated,
        };
      }

      switch (classified.kind) {
        case "corrupt":
          return {
            kind: "corrupt",
            streamId: options.streamId,
            turns: [turn],
            events: classified.events,
            report: classified.report,
            truncated: classified.truncated,
          };
        case "partial":
          return {
            kind: "partial",
            turns: [turn],
            events: classified.events,
            report: classified.report,
            truncated: true,
          };
        case "rebuilt":
          return {
            kind: "rebuilt",
            turns: [turn],
            events: classified.events,
            report: classified.report,
            truncated: false,
          };
        default: {
          const _exhaustive: never = classified;
          return _exhaustive;
        }
      }
    },
  };
}
