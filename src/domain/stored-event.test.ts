import { describe, expect, test } from "bun:test";

import { capabilityInvocationStarted, everyEventKind, sessionStarted } from "./fixtures.ts";
import { traceId } from "./identity.ts";
import { fromStoredEvent, toStoredEvent } from "./stored-event.ts";

describe("mapping onto the persisted shape", () => {
  test.each(everyEventKind().map((event) => [event.kind, event] as const))(
    "%s maps to a stored event and back without loss",
    (_kind, event) => {
      const restored = fromStoredEvent(toStoredEvent(event));
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expect(restored.value).toEqual(event);
      }
    },
  );

  test("fills the declared columns from the envelope", () => {
    const event = sessionStarted(1);
    const stored = toStoredEvent(event);
    expect(stored).toMatchObject({
      eventId: event.eventId,
      aggregateId: event.streamId,
      sequence: 1,
      kind: "session.started",
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      traceId: event.correlation.traceId,
    });
  });

  test("keeps trace identity in its column only, so the two cannot disagree", () => {
    const stored = toStoredEvent(sessionStarted(1));
    const correlation = stored.payload.correlation as Record<string, unknown>;
    expect(correlation).not.toHaveProperty("traceId");
    expect(Object.keys(correlation).sort()).toEqual([
      "configurationGeneration",
      "sessionId",
      "workspaceId",
    ]);
  });

  test("carries envelope identity that has no column into the payload", () => {
    const stored = toStoredEvent(capabilityInvocationStarted(1));
    expect(stored.payload).toMatchObject({
      idempotencyKey: "key-invocation-start-1",
      invocationId: "invocation-fixture",
      capabilityId: "workspace.read",
    });
  });
});

describe("reading an untrusted row", () => {
  test("a row edited to an unknown kind is rejected, not reinterpreted", () => {
    const stored = { ...toStoredEvent(sessionStarted(1)), kind: "session.resumed" };
    const restored = fromStoredEvent(stored);
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.kind).toBe("unknown-event-kind");
    }
  });

  test("a row whose correlation was lost is rejected", () => {
    const stored = toStoredEvent(sessionStarted(1));
    const restored = fromStoredEvent({ ...stored, payload: { ...stored.payload, correlation: 7 } });
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.kind).toBe("invalid-envelope");
    }
  });

  test("the trace column is the authority for the restored event", () => {
    const stored = toStoredEvent(sessionStarted(1));
    const restored = fromStoredEvent({ ...stored, traceId: traceId.from("trace-recovered") });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value.correlation.traceId).toBe(traceId.from("trace-recovered"));
    }
  });
});
