import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  eventId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  nextSequence,
  sequence,
  sessionId,
  turnId,
} from "./identity.ts";
import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";

describe("identifier parsing", () => {
  test("accepts a printable identifier", () => {
    const parsed = sessionId.parse("session-01HXYZ");
    expect(parsed.ok).toBe(true);
  });

  test("rejects an empty identifier", () => {
    const parsed = sessionId.parse("");
    expect(parsed).toEqual({
      ok: false,
      error: { kind: "identity", code: "identifier-empty", identity: "sessionId" },
    });
  });

  test("rejects an identifier past the declared length bound", () => {
    const parsed = eventId.parse("e".repeat(MAX_IDENTIFIER_LENGTH + 1));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("identifier-too-long");
    }
  });

  test("accepts an identifier exactly at the bound", () => {
    expect(eventId.parse("e".repeat(MAX_IDENTIFIER_LENGTH)).ok).toBe(true);
  });

  test.each([
    ["whitespace", "session id"],
    ["newline", "session\nid"],
    ["control character", "session\u0001id"],
    ["tab", "session\tid"],
    ["non-ascii", "sessioné"],
  ])("rejects an identifier containing %s", (_label, value) => {
    const parsed = sessionId.parse(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("identifier-illegal-character");
    }
  });

  test("rejects a non-string identifier", () => {
    const parsed = sessionId.parse(42);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("identifier-not-a-string");
    }
  });

  test("never reports the rejected value", () => {
    const parsed = sessionId.parse("token sk-live-SECRET");
    expect(JSON.stringify(parsed)).not.toContain("sk-live-SECRET");
  });

  test("from throws on invalid input", () => {
    expect(() => turnId.from("")).toThrow("invalid turnId");
  });
});

describe("integer identities", () => {
  test("rejects a non-integer sequence", () => {
    const parsed = sequence.parse(1.5);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("number-not-an-integer");
    }
  });

  test("rejects a sequence below the first legal value", () => {
    const parsed = sequence.parse(FIRST_SEQUENCE - 1);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("number-out-of-range");
    }
  });

  test("accepts the first configuration generation", () => {
    expect(configurationGeneration.parse(FIRST_CONFIGURATION_GENERATION).ok).toBe(true);
  });

  test("rejects a negative configuration generation", () => {
    expect(configurationGeneration.parse(-1).ok).toBe(false);
  });

  test("nextSequence advances by one", () => {
    expect(nextSequence(FIRST_SEQUENCE)).toBe(sequence.from(2));
  });
});
