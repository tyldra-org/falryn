import { describe, expect, test } from "bun:test";

import { decodeRuntimeEvent, encodedByteLength, encodeRuntimeEvent } from "./codec.ts";
import { everyEventKind, modelAttemptStarted, sessionStarted, turnCompleted } from "./fixtures.ts";
import { capabilityId, configurationGeneration, modelId, providerId } from "./identity.ts";
import { MAX_EVENT_BYTES, RUNTIME_EVENT_SCHEMA_VERSION } from "./limits.ts";
import { toWireEvent } from "./wire.ts";

const encoder = new TextEncoder();

function wireOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...toWireEvent(sessionStarted()), ...overrides };
}

function decodeJson(value: unknown) {
  return decodeRuntimeEvent(JSON.stringify(value));
}

describe("round trip", () => {
  test.each(everyEventKind().map((event) => [event.kind, event] as const))(
    "%s survives encode and decode unchanged",
    (_kind, event) => {
      const encoded = encodeRuntimeEvent(event);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) {
        return;
      }
      const decoded = decodeRuntimeEvent(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) {
        return;
      }
      expect(decoded.value).toEqual(event);
    },
  );

  test("encoding is canonical, so equal events produce equal bytes", () => {
    const event = turnCompleted(3, { kind: "timed-out", effect: "uncertain" });
    const first = encodeRuntimeEvent(event);
    const second = encodeRuntimeEvent({ ...event });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(new TextDecoder().decode(first.value)).toBe(new TextDecoder().decode(second.value));
    }
  });

  test("every declared kind encodes well inside the byte bound", () => {
    for (const event of everyEventKind()) {
      const size = encodedByteLength(event);
      expect(size.ok).toBe(true);
      if (size.ok) {
        expect(size.value).toBeLessThan(MAX_EVENT_BYTES);
      }
    }
  });

  test("preserves the immutable provider and capability binding", () => {
    const event = modelAttemptStarted();
    const bound = {
      ...event,
      payload: {
        binding: {
          schemaVersion: 1 as const,
          providerId: providerId.from("provider-a"),
          modelId: modelId.from("model-a"),
          role: "default",
          intent: "coding",
          reasoning: "balanced",
          providerCatalogGeneration: 3,
          toolCatalogGeneration: configurationGeneration.from(4),
          policyGeneration: configurationGeneration.from(4),
          runner: "product-attempt-runner.v1" as const,
          gateway: "product-tool-gateway.v1" as const,
          discoveryHandle: "capability-catalog:4",
          capabilityCatalog: {
            total: 1,
            counts: { tool: 1 },
            cards: [
              {
                capabilityId: capabilityId.from("workspace.read_file"),
                kind: "tool",
                family: "read",
                source: "builtin",
                version: 1,
                costClass: "unknown",
                latencyClass: "unknown",
                available: true,
                executable: true,
                disclosed: true,
              },
            ],
          },
          families: [{ family: "read", available: true, reason: null }],
          tools: [
            {
              name: "read_file",
              capabilityId: capabilityId.from("workspace.read_file"),
              version: 1,
              schemaDigest: "sha-256:read",
              schemaBytes: 48,
              schemaTokensEstimated: 12,
            },
          ],
          omitted: [{ name: "write_files", reason: "confirmation unavailable" }],
          schemaBytes: 48,
          schemaTokensEstimated: 12,
          budgets: {
            attempts: 2,
            inputTokens: 8_000,
            outputTokens: 2_000,
            wallTimeMs: 30_000,
            cost: null,
          },
        },
      },
    };
    const encoded = encodeRuntimeEvent(bound);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) {
      return;
    }
    const decoded = decodeRuntimeEvent(encoded.value);
    expect(decoded).toEqual({ ok: true, value: bound });
  });
});

describe("unknown kinds", () => {
  test("rejects an undeclared kind and preserves the observed value", () => {
    const decoded = decodeJson(wireOf({ kind: "session.resumed" }));
    expect(decoded).toEqual({
      ok: false,
      error: { kind: "unknown-event-kind", observedKind: "session.resumed" },
    });
  });

  test("never maps an unknown kind onto a declared one", () => {
    const decoded = decodeJson(wireOf({ kind: "session.started.v2" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.error.kind === "unknown-event-kind") {
      expect(decoded.error.observedKind).not.toBe("session.started");
    }
  });

  test("withholds a kind that is not a structural identifier", () => {
    const decoded = decodeJson(wireOf({ kind: "token sk-live-SECRET" }));
    expect(decoded.ok).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain("sk-live-SECRET");
  });

  test("withholds an over-long kind", () => {
    const decoded = decodeJson(wireOf({ kind: "k".repeat(200) }));
    expect(decoded).toEqual({
      ok: false,
      error: { kind: "unknown-event-kind", observedKind: "<unreportable>" },
    });
  });
});

describe("version skew", () => {
  test("accepts a future version whose additions are optional", () => {
    const decoded = decodeJson(
      wireOf({
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        introducedLater: "additive",
        payload: { alsoAdditive: true },
      }),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.schemaVersion).toBe(RUNTIME_EVENT_SCHEMA_VERSION + 1);
      expect(decoded.value.payload).toEqual({});
      expect(Object.keys(decoded.value)).not.toContain("introducedLater");
    }
  });

  test("rejects a future version that requires a newer reader", () => {
    const decoded = decodeJson(
      wireOf({
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
      }),
    );
    expect(decoded).toEqual({
      ok: false,
      error: {
        kind: "unsupported-schema-version",
        observedSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        minimumCompatibleVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        readerSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      },
    });
  });

  test("treats an absent minimum reader version as this version", () => {
    const wire = wireOf();
    delete wire.minimumReaderSchemaVersion;
    const decoded = decodeJson(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.minimumReaderSchemaVersion).toBe(RUNTIME_EVENT_SCHEMA_VERSION);
    }
  });

  test("rejects a non-integer schema version", () => {
    const decoded = decodeJson(wireOf({ schemaVersion: "1" }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.error.kind === "invalid-envelope") {
      expect(decoded.error.issues).toEqual([{ path: "schemaVersion", code: "invalid_type" }]);
    }
  });
});

describe("malformed input", () => {
  test("rejects bytes that are not valid UTF-8", () => {
    const decoded = decodeRuntimeEvent(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(decoded).toEqual({ ok: false, error: { kind: "malformed-encoding" } });
  });

  test("rejects text that is not valid JSON", () => {
    const decoded = decodeRuntimeEvent('{"kind": "session.started",');
    expect(decoded).toEqual({ ok: false, error: { kind: "malformed-json" } });
  });

  test.each([
    ["an array", "[]"],
    ["a string", '"session.started"'],
    ["null", "null"],
  ])("rejects %s at the root", (_label, text) => {
    expect(decodeRuntimeEvent(text)).toEqual({ ok: false, error: { kind: "not-an-object" } });
  });

  test("rejects an event larger than the declared bound before parsing it", () => {
    const oversized = JSON.stringify(wireOf({ filler: "x".repeat(MAX_EVENT_BYTES) }));
    const decoded = decodeRuntimeEvent(oversized);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.error.kind === "oversized-event") {
      expect(decoded.error.maximumBytes).toBe(MAX_EVENT_BYTES);
      expect(decoded.error.byteLength).toBeGreaterThan(MAX_EVENT_BYTES);
    }
  });

  test("accepts an event exactly at the byte bound", () => {
    const base = JSON.stringify(wireOf({ filler: "" }));
    const room = MAX_EVENT_BYTES - encoder.encode(base).byteLength;
    const exact = JSON.stringify(wireOf({ filler: "x".repeat(room) }));
    expect(encoder.encode(exact).byteLength).toBe(MAX_EVENT_BYTES);
    expect(decodeRuntimeEvent(exact).ok).toBe(true);
  });

  test("rejects an undeclared terminal outcome", () => {
    const wire = toWireEvent(turnCompleted());
    const decoded = decodeJson({ ...wire, payload: { outcome: { kind: "succeeded" } } });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok && decoded.error.kind === "invalid-envelope") {
      expect(decoded.error.issues[0]?.path).toBe("payload.outcome.kind");
    }
  });
});

describe("sensitive data", () => {
  test("a rejection reports structure only, never the rejected value", () => {
    const decoded = decodeJson(wireOf({ sequence: "one", payload: { apiKey: "sk-live-SECRET" } }));
    expect(decoded.ok).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain("sk-live-SECRET");
    if (!decoded.ok && decoded.error.kind === "invalid-envelope") {
      for (const issue of decoded.error.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
      }
    }
  });

  test("an accepted event drops data this build cannot interpret", () => {
    const decoded = decodeJson(wireOf({ payload: { apiKey: "sk-live-SECRET" } }));
    expect(decoded.ok).toBe(true);
    expect(JSON.stringify(decoded)).not.toContain("sk-live-SECRET");
  });
});

describe("encoding validation", () => {
  test("refuses to encode a value assembled through an unchecked cast", () => {
    const invalid = { ...sessionStarted(), eventId: "" } as ReturnType<typeof sessionStarted>;
    const encoded = encodeRuntimeEvent(invalid);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok && encoded.error.kind === "invalid-envelope") {
      expect(encoded.error.issues[0]?.path).toBe("eventId");
    }
  });
});
