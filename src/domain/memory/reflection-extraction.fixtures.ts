/** Committed turn events for reflection tests: one stream, sequential, several turns. */
import { createHash } from "node:crypto";
import {
  FIXTURE_OCCURRED_AT,
  FIXTURE_SESSION_CORRELATION,
  FIXTURE_STREAM,
  sessionStarted,
} from "../fixtures.ts";
import {
  capabilityId,
  eventId,
  idempotencyKey,
  invocationId,
  sequence,
  turnId,
} from "../foundation/identity.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../foundation/limits.ts";
import type { TerminalOutcome } from "../orchestration/outcome.ts";
import type { RuntimeEvent } from "../sessions/event.ts";

export type FixtureTurn = {
  readonly id: string;
  readonly messages: readonly (string | { readonly retained: true })[];
  readonly failures?: readonly string[];
  readonly outcome?: TerminalOutcome;
  /** Omit the terminal event: an uncommitted turn. */
  readonly unfinished?: boolean;
};

/** Events for these turns, starting at the given sequence (1 includes session.started). */
export function reflectionTurnEvents(turns: readonly FixtureTurn[], start = 1): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let position = start;
  const spine = (label: string) => {
    const at = position++;
    return {
      eventId: eventId.from("event-" + label + "-" + at),
      streamId: FIXTURE_STREAM,
      sequence: sequence.from(at),
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      occurredAt: FIXTURE_OCCURRED_AT,
      idempotencyKey: idempotencyKey.from("key-" + label + "-" + at),
    };
  };
  if (start === 1) {
    events.push(sessionStarted(1));
    position += 1;
  }
  for (const turn of turns) {
    const correlation = { ...FIXTURE_SESSION_CORRELATION, turnId: turnId.from(turn.id) };
    events.push({ ...spine("turn-start"), kind: "turn.started", correlation, payload: {} });
    turn.messages.forEach((message, part) => {
      const text = typeof message === "string" ? message : "retained";
      const digest = "sha-256:" + createHash("sha256").update(text).digest("hex");
      events.push({
        ...spine("message"),
        kind: "history.recorded",
        correlation,
        payload: {
          version: 1,
          id: turn.id + "-user-" + part,
          generation: 0,
          type: "message",
          messageId: turn.id + "-user-" + part,
          part: 0,
          role: "user",
          attemptId: null,
          completion: "complete",
          relations: [],
          evidence:
            typeof message === "string"
              ? {
                  availability: "inline",
                  text,
                  digest,
                  byteLength: Buffer.byteLength(text),
                  sensitivity: "user-content",
                  fidelity: "exact",
                }
              : {
                  availability: "retained",
                  artifactId: "artifact-" + turn.id + "-" + part,
                  digest,
                  byteLength: 4096,
                  sensitivity: "user-content",
                  fidelity: "exact",
                  mediaType: "text/plain",
                },
        },
      } as RuntimeEvent);
    });
    for (const failure of turn.failures ?? [])
      events.push({
        ...spine("tool"),
        kind: "capability.invocation.completed",
        invocationId: invocationId.from("invocation-" + position),
        capabilityId: capabilityId.from(failure),
        correlation,
        payload: { outcome: { kind: "failed", effect: "none" }, observedStatus: "failed" },
      } as RuntimeEvent);
    if (!turn.unfinished)
      events.push({
        ...spine("turn-done"),
        kind: "turn.completed",
        correlation,
        payload: { outcome: turn.outcome ?? { kind: "completed" } },
      } as RuntimeEvent);
  }
  return events;
}
