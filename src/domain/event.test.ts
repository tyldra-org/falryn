import { describe, expect, test } from "bun:test";

import {
  EVENT_KINDS,
  type EventKind,
  isEventKind,
  isModelEvent,
  isToolEvent,
  type RuntimeEvent,
  summarizeEvent,
} from "./event.ts";
import {
  capabilityInvocationCompleted,
  everyEventKind,
  modelAttemptStarted,
  sessionStarted,
  turnStarted,
} from "./fixtures.ts";
import { capabilityId, invocationId, turnId } from "./identity.ts";
import { assertNever } from "./result.ts";

/** Fails type-checking if a kind is added to the union without handling. */
function carriesTurnIdentity(event: RuntimeEvent): boolean {
  switch (event.kind) {
    case "session.started":
    case "configuration.generation.changed":
    case "execution.profile.selected":
      return false;
    case "turn.started":
    case "turn.completed":
    case "model.attempt.started":
    case "model.attempt.completed":
    case "capability.invocation.started":
    case "capability.invocation.completed":
      return true;
    default:
      return assertNever(event, "unhandled event kind");
  }
}

describe("event kinds", () => {
  test("a fixture exists for every declared kind", () => {
    const kinds = everyEventKind().map((event) => event.kind);
    expect(kinds).toEqual([...EVENT_KINDS]);
  });

  test("recognizes declared kinds and refuses undeclared ones", () => {
    for (const kind of EVENT_KINDS) {
      expect(isEventKind(kind)).toBe(true);
    }
    expect(isEventKind("turn.paused")).toBe(false);
    expect(isEventKind(null)).toBe(false);
  });

  test("classifies model and tool events", () => {
    expect(isModelEvent(modelAttemptStarted())).toBe(true);
    expect(isToolEvent(modelAttemptStarted())).toBe(false);
    expect(isToolEvent(capabilityInvocationCompleted())).toBe(true);
    expect(isModelEvent(capabilityInvocationCompleted())).toBe(false);
  });

  test("only turn-scoped kinds carry turn identity", () => {
    const scoped = new Map<EventKind, boolean>(
      everyEventKind().map((event) => [event.kind, carriesTurnIdentity(event)]),
    );
    expect(scoped.get("session.started")).toBe(false);
    expect(scoped.get("configuration.generation.changed")).toBe(false);
    expect(scoped.get("execution.profile.selected")).toBe(false);
    expect(scoped.get("turn.started")).toBe(true);
  });
});

describe("event summaries", () => {
  test("carry correlation for a tool event", () => {
    const summary = summarizeEvent(capabilityInvocationCompleted());
    expect(summary.invocationId).toBe(invocationId.from("invocation-fixture"));
    expect(summary.capabilityId).toBe(capabilityId.from("workspace.read"));
    expect(summary.turnId).toBe(turnId.from("turn-fixture"));
    expect(summary.modelAttemptId).toBeNull();
  });

  test("report absent identity as null rather than omitting it", () => {
    const summary = summarizeEvent(sessionStarted());
    expect(summary.turnId).toBeNull();
    expect(summary.invocationId).toBeNull();
    expect(summary.capabilityId).toBeNull();
    expect(summary.modelAttemptId).toBeNull();
  });

  test("never include payload content", () => {
    const summary = summarizeEvent(turnStarted());
    expect(Object.keys(summary)).not.toContain("payload");
  });
});
