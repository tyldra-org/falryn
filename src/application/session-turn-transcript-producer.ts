/**
 * Live session/turn/transcript producer (#706).
 *
 * Starts sessions and turns on the product agent runtime, appends lifecycle
 * facts through the durable turn journal, and exposes the resulting
 * {@link RuntimeEvent} stream for OpenTUI transcript projection and headless
 * JSONL. Replay stays effect-free: consumers fold stored events only.
 *
 * Does not own mid-turn classification (#610–#613), composer submission (#707),
 * session resume/fork CLI (#702), builtin tool registration (#700), or live
 * vendor adapters (#709).
 */

import {
  type CapabilityId,
  type ConfigurationGeneration,
  type EventStorePort,
  type InvocationId,
  MAX_STREAM_READ_LIMIT,
  type ModelAttemptId,
  type RuntimeEvent,
  type Sequence,
  type SessionCorrelation,
  type SessionId,
  type StreamId,
  type TerminalOutcome,
  type TraceId,
  type TurnId,
  type TurnLifecycleFact,
  type WorkspaceId,
} from "../domain/index.ts";
import type { SessionRuntime, SessionRuntimeError } from "./session-runtime.ts";
import type { StartTurnInput, TurnCoordinator, TurnCoordinatorError } from "./turn-coordinator.ts";
import type { PersistTurnEventsOutcome, TurnEventJournal } from "./turn-event-journal.ts";

export type SessionTurnTranscriptProducerOptions = {
  readonly eventStore: EventStorePort;
  readonly journal: TurnEventJournal;
  readonly sessionRuntime: SessionRuntime;
  readonly turnCoordinator: TurnCoordinator;
  readonly streamId: StreamId;
  readonly correlation: SessionCorrelation;
};

export type ProducerSessionInput = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
};

export type ProducerTurnInput = StartTurnInput;

export type ProducerModelAttemptInput = {
  readonly turnId: TurnId;
  readonly modelAttemptId: ModelAttemptId;
  readonly correlation: SessionCorrelation & { readonly turnId: TurnId };
  readonly outcome: TerminalOutcome;
};

export type ProducerToolInvocationInput = {
  readonly turnId: TurnId;
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
  readonly correlation: SessionCorrelation & { readonly turnId: TurnId };
  readonly outcome: TerminalOutcome;
};

export type ProducerError =
  | { readonly code: "session-runtime"; readonly error: SessionRuntimeError }
  | { readonly code: "turn-coordinator"; readonly error: TurnCoordinatorError }
  | { readonly code: "persist"; readonly persist: PersistTurnEventsOutcome }
  | { readonly code: "store-error"; readonly message: string };

export type ProducerResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ProducerError };

export type SessionTurnTranscriptProducer = {
  readonly streamId: StreamId;
  readonly correlation: SessionCorrelation;
  /** Ordered runtime events appended so far on this product stream. */
  events(): readonly RuntimeEvent[];
  /** Notify listeners when new events are available (after persist). */
  subscribe(listener: () => void): () => void;
  /** Replace the in-memory cache from the durable store (same-process resume). */
  refreshFromStore(): Promise<ProducerResult<void>>;
  /** Open a session (bootstrap → ready) and persist `session.started`. */
  startSession(
    input: ProducerSessionInput,
  ): Promise<ProducerResult<{ readonly sessionId: SessionId }>>;
  /** Start a turn and persist `turn.started`. */
  startTurn(input: ProducerTurnInput): Promise<ProducerResult<{ readonly turnId: TurnId }>>;
  /** Persist `turn.completed` and end the session's active turn phase. */
  completeTurn(input: {
    readonly turnId: TurnId;
    readonly sessionId: SessionId;
    readonly workspaceId: WorkspaceId;
    readonly traceId: TraceId;
    readonly configurationGeneration: ConfigurationGeneration;
    readonly outcome: TerminalOutcome;
  }): Promise<ProducerResult<{ readonly turnId: TurnId }>>;
  /** Persist a completed model attempt pair (start + complete). */
  recordModelAttempt(
    input: ProducerModelAttemptInput,
  ): Promise<ProducerResult<{ readonly modelAttemptId: ModelAttemptId }>>;
  /** Persist a completed capability invocation pair (start + complete). */
  recordToolInvocation(
    input: ProducerToolInvocationInput,
  ): Promise<ProducerResult<{ readonly invocationId: InvocationId }>>;
};

/**
 * Create a producer over an already-composed product agent runtime graph.
 */
export function createSessionTurnTranscriptProducer(
  options: SessionTurnTranscriptProducerOptions,
): SessionTurnTranscriptProducer {
  const listeners = new Set<() => void>();
  let cached: RuntimeEvent[] = [];
  let knownEventIds = new Set<string>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  options.journal.subscribe((events) => {
    const committed = events.filter((event) => !knownEventIds.has(String(event.eventId)));
    if (committed.length === 0) {
      return;
    }
    for (const event of committed) {
      knownEventIds.add(String(event.eventId));
    }
    cached = [...cached, ...committed];
    notify();
  });

  async function persistFacts(
    facts: readonly TurnLifecycleFact[],
  ): Promise<ProducerResult<PersistTurnEventsOutcome>> {
    const persist = await options.journal.persist(facts);
    if (persist.kind !== "persisted") {
      return { ok: false, error: { code: "persist", persist } };
    }
    return { ok: true, value: persist };
  }

  return {
    streamId: options.streamId,
    correlation: options.correlation,
    events: () => cached,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refreshFromStore() {
      const events: RuntimeEvent[] = [];
      let afterSequence: Sequence | null = null;
      for (;;) {
        const page = await options.eventStore.readFrom(
          { streamId: options.streamId, afterSequence },
          MAX_STREAM_READ_LIMIT,
        );
        if (!page.ok) {
          return {
            ok: false,
            error: { code: "store-error", message: page.error.code },
          };
        }
        events.push(...page.value);
        const tail = page.value.at(-1);
        if (tail === undefined || page.value.length < MAX_STREAM_READ_LIMIT) {
          break;
        }
        afterSequence = tail.sequence;
      }
      cached = events;
      knownEventIds = new Set(events.map((event) => String(event.eventId)));
      notify();
      return { ok: true, value: undefined };
    },

    async startSession(input) {
      const created = options.sessionRuntime.create({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        configurationGeneration: input.configurationGeneration,
      });
      if (!created.ok) {
        return { ok: false, error: { code: "session-runtime", error: created.error } };
      }
      const ready = options.sessionRuntime.apply({
        sessionId: input.sessionId,
        command: "mark-ready",
        configurationGeneration: input.configurationGeneration,
      });
      if (!ready.ok) {
        return { ok: false, error: { code: "session-runtime", error: ready.error } };
      }

      const correlation: SessionCorrelation = {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        traceId: options.correlation.traceId,
        configurationGeneration: input.configurationGeneration,
      };
      const persisted = await persistFacts([{ kind: "session.started", correlation }]);
      if (!persisted.ok) {
        return persisted;
      }
      return { ok: true, value: { sessionId: input.sessionId } };
    },

    async startTurn(input) {
      const begin = options.sessionRuntime.apply({
        sessionId: input.sessionId,
        command: "begin-turn",
        configurationGeneration: input.configurationGeneration,
      });
      if (!begin.ok) {
        return { ok: false, error: { code: "session-runtime", error: begin.error } };
      }

      const started = options.turnCoordinator.start(input);
      if (!started.ok) {
        return { ok: false, error: { code: "turn-coordinator", error: started.error } };
      }

      const persisted = await persistFacts([
        {
          kind: "turn.started",
          correlation: {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            traceId: input.traceId,
            configurationGeneration: input.configurationGeneration,
            turnId: input.turnId,
          },
        },
      ]);
      if (!persisted.ok) {
        return persisted;
      }
      return { ok: true, value: { turnId: input.turnId } };
    },

    async completeTurn(input) {
      const correlation = {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        traceId: input.traceId,
        configurationGeneration: input.configurationGeneration,
        turnId: input.turnId,
      };
      const persisted = await persistFacts([
        {
          kind: "turn.completed",
          correlation,
          outcome: input.outcome,
        },
      ]);
      if (!persisted.ok) {
        return persisted;
      }

      const ended = options.sessionRuntime.apply({
        sessionId: input.sessionId,
        command: "end-turn",
        configurationGeneration: input.configurationGeneration,
        outcome: input.outcome,
      });
      if (!ended.ok) {
        return { ok: false, error: { code: "session-runtime", error: ended.error } };
      }
      return { ok: true, value: { turnId: input.turnId } };
    },

    async recordModelAttempt(input) {
      const persisted = await persistFacts([
        {
          kind: "model.attempt.started",
          correlation: input.correlation,
          modelAttemptId: input.modelAttemptId,
        },
        {
          kind: "model.attempt.completed",
          correlation: input.correlation,
          modelAttemptId: input.modelAttemptId,
          outcome: input.outcome,
        },
      ]);
      if (!persisted.ok) {
        return persisted;
      }
      return { ok: true, value: { modelAttemptId: input.modelAttemptId } };
    },

    async recordToolInvocation(input) {
      const persisted = await persistFacts([
        {
          kind: "capability.invocation.started",
          correlation: input.correlation,
          invocationId: input.invocationId,
          capabilityId: input.capabilityId,
        },
        {
          kind: "capability.invocation.completed",
          correlation: input.correlation,
          invocationId: input.invocationId,
          capabilityId: input.capabilityId,
          outcome: input.outcome,
        },
      ]);
      if (!persisted.ok) {
        return persisted;
      }
      return { ok: true, value: { invocationId: input.invocationId } };
    },
  };
}
