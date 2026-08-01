import { describe, expect, test } from "bun:test";

import {
  type CorrelationIds,
  createManualClock,
  DIAGNOSTIC_SUBSYSTEMS,
  duration,
  instant,
  MAX_DIAGNOSTIC_CARDINALITY,
  MAX_DIAGNOSTIC_METADATA_KEYS,
  MAX_RETAINED_DIAGNOSTICS,
  NO_CORRELATION,
  scopeId,
  sessionId,
  traceId,
} from "../domain/index.ts";
import { createDiagnosticsCollector } from "./diagnostics-collector.ts";
import { containsRedactableSecret, openDebugWindow, redactText } from "./redaction.ts";

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

const CORRELATION: CorrelationIds = {
  ...NO_CORRELATION,
  sessionId: sessionId.from("session-1"),
  traceId: traceId.from("trace-1"),
  scopeId: scopeId.from("scope-1"),
};

describe("what the runtime can describe", () => {
  test("only names subsystems that actually emit today", () => {
    // `credentials` joined the list with the secret resolver, which emits one
    // diagnostic per resolution.
    expect([...DIAGNOSTIC_SUBSYSTEMS]).toEqual([
      "scope",
      "scheduler",
      "shutdown",
      "codec",
      "credentials",
    ]);
  });

  test("records a scope state transition with its correlation", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    const outcome = collector.emit({
      level: "info",
      subsystem: "scope",
      code: "scope.terminal",
      correlation: CORRELATION,
      stage: "acknowledge",
    });

    expect(outcome.kind).toBe("recorded");
    if (outcome.kind === "recorded") {
      expect(outcome.event.correlation.sessionId).toBe(sessionId.from("session-1"));
      expect(outcome.event.at).toBe(instant(0));
      expect(outcome.event.stage).toBe("acknowledge");
    }
  });

  test("records cancellation latency as a duration, not a payload", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    const outcome = collector.emit({
      level: "info",
      subsystem: "scope",
      code: "scope.cancellation.acknowledged",
      durationMs: duration(120),
    });

    if (outcome.kind === "recorded") {
      expect(outcome.event.durationMs).toBe(duration(120));
      expect(Object.keys(outcome.event.metadata)).toEqual([]);
    }
  });

  test("records queue wait and active budget against their declared limits", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    const outcome = collector.emit({
      level: "warn",
      subsystem: "scheduler",
      code: "scheduler.queue.depth",
      limits: { maxConcurrent: 8 },
      metadata: { queued: 12, priority: "maintenance" },
    });

    if (outcome.kind === "recorded") {
      expect(outcome.event.limits).toEqual({ maxConcurrent: 8 });
      expect(outcome.event.metadata).toEqual({ queued: 12, priority: "maintenance" });
    }
  });

  test("an event with no correlation still carries the full shape", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });
    const outcome = collector.emit({ level: "debug", subsystem: "codec", code: "codec.decoded" });

    if (outcome.kind === "recorded") {
      expect(outcome.event.correlation).toEqual(NO_CORRELATION);
      expect(outcome.event.durationMs).toBeNull();
      expect(outcome.event.limits).toBeNull();
    }
  });
});

describe("bounds", () => {
  test("retention is bounded and drops are counted", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    for (let index = 0; index < MAX_RETAINED_DIAGNOSTICS + 500; index += 1) {
      collector.emit({ level: "debug", subsystem: "scope", code: "scope.opened" });
    }

    expect(collector.events().length).toBeLessThanOrEqual(MAX_RETAINED_DIAGNOSTICS);
    expect(collector.report().dropped).toBeGreaterThan(0);
  });

  test("cardinality is bounded and refusals are reported, not silent", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    for (let index = 0; index < MAX_DIAGNOSTIC_CARDINALITY; index += 1) {
      collector.emit({ level: "debug", subsystem: "scope", code: `series-${index}` });
    }
    const refused = collector.emit({ level: "debug", subsystem: "scope", code: "one-too-many" });

    expect(refused).toEqual({
      kind: "refused",
      reason: "cardinality-exceeded",
      maximum: MAX_DIAGNOSTIC_CARDINALITY,
    });
    expect(collector.report().refusedForCardinality).toBe(1);
  });

  test("an existing series is still accepted once cardinality is full", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    for (let index = 0; index < MAX_DIAGNOSTIC_CARDINALITY; index += 1) {
      collector.emit({ level: "debug", subsystem: "scope", code: `series-${index}` });
    }
    expect(collector.emit({ level: "debug", subsystem: "scope", code: "series-0" }).kind).toBe(
      "recorded",
    );
  });

  test("metadata keys are bounded", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });
    const metadata = Object.fromEntries(
      Array.from({ length: MAX_DIAGNOSTIC_METADATA_KEYS + 10 }, (_value, index) => [
        `key-${index}`,
        index,
      ]),
    );

    const outcome = collector.emit({
      level: "debug",
      subsystem: "scope",
      code: "scope.opened",
      metadata,
    });
    if (outcome.kind === "recorded") {
      expect(Object.keys(outcome.event.metadata)).toHaveLength(MAX_DIAGNOSTIC_METADATA_KEYS);
    }
  });
});

describe("redaction", () => {
  test.each([
    ["an api key assignment", `api_key=${SECRET}`],
    ["a bearer token", `authorization: Bearer ${SECRET}`],
    ["a credential-bearing URL", "postgres://admin:hunter2@db.internal/app"],
    ["a bare provider key", "sk-live-ABCDEFGHIJKLMNOP"],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE"],
  ])("strips %s", (_label, text) => {
    expect(containsRedactableSecret(text)).toBe(true);
    const redacted = redactText(text);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("leaves ordinary diagnostic text alone", () => {
    expect(redactText("queue depth 12 exceeded maxItems 8")).toBe(
      "queue depth 12 exceeded maxItems 8",
    );
    expect(containsRedactableSecret("queue depth 12")).toBe(false);
  });

  test("a secret in metadata never reaches a recorded event", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    const outcome = collector.emit({
      level: "error",
      subsystem: "codec",
      code: "codec.rejected",
      metadata: { detail: `token=${SECRET}` },
    });

    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(collector.events())).not.toContain(SECRET);
  });

  test("a shapeless value under a secret-named metadata key is still redacted", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    // No recognizable credential shape, so only the key name can save it.
    const outcome = collector.emit({
      level: "error",
      subsystem: "codec",
      code: "codec.rejected",
      metadata: { authToken: "p4ss", note: "fine" },
    });

    if (outcome.kind === "recorded") {
      expect(outcome.event.metadata.authToken).toBe("[redacted]");
      expect(outcome.event.metadata.note).toBe("fine");
    }
    expect(JSON.stringify(collector.events())).not.toContain("p4ss");
  });

  test("a secret in a code or stage never reaches a recorded event", () => {
    const clock = createManualClock(instant(0));
    const collector = createDiagnosticsCollector({ clock });

    collector.emit({
      level: "error",
      subsystem: "codec",
      code: `codec.${SECRET}`,
      stage: `password=${SECRET}`,
    });
    expect(JSON.stringify(collector.events())).not.toContain(SECRET);
  });
});

describe("debug mode", () => {
  test("is time-scoped", async () => {
    const clock = createManualClock(instant(0));
    const window = openDebugWindow({ clock, ttlMs: duration(1_000), maxPreviews: 10 });

    expect(window.isOpen()).toBe(true);
    await clock.advance(duration(1_000));
    expect(window.isOpen()).toBe(false);
    expect(window.preview("anything")).toBeNull();
  });

  test("is bounded by preview count", () => {
    const clock = createManualClock(instant(0));
    const window = openDebugWindow({ clock, ttlMs: duration(60_000), maxPreviews: 2 });

    expect(window.preview("first")).toBe("first");
    expect(window.preview("second")).toBe("second");
    expect(window.preview("third")).toBeNull();
    expect(window.previewsRemaining()).toBe(0);
  });

  test("still redacts", () => {
    const clock = createManualClock(instant(0));
    const window = openDebugWindow({ clock, ttlMs: duration(60_000), maxPreviews: 5 });

    const preview = window.preview(`request failed api_key=${SECRET}`);
    expect(preview).not.toBeNull();
    expect(preview).not.toContain(SECRET);
  });

  test("a caller cannot request a longer window than the declared maximum", () => {
    const clock = createManualClock(instant(0));
    const window = openDebugWindow({
      clock,
      ttlMs: duration(24 * 60 * 60 * 1_000),
      maxPreviews: 10_000,
    });

    expect(window.expiresAt()).toBe(instant(15 * 60 * 1_000));
    expect(window.previewsRemaining()).toBe(100);
  });

  test("closing it early stops previews", () => {
    const clock = createManualClock(instant(0));
    const window = openDebugWindow({ clock, ttlMs: duration(60_000), maxPreviews: 5 });
    window.close();

    expect(window.isOpen()).toBe(false);
    expect(window.preview("anything")).toBeNull();
  });
});
