import { describe, expect, test } from "bun:test";

import {
  EFFECT_CERTAINTIES,
  effectOf,
  isTerminalOutcomeKind,
  requiresInspection,
  TERMINAL_OUTCOME_KINDS,
  type TerminalOutcome,
  type TerminalOutcomeKind,
} from "./outcome.ts";
import { assertNever } from "./result.ts";

/**
 * Compile-time exhaustiveness guard.
 *
 * Adding a terminal outcome without handling it here fails `tsc --noEmit`
 * before any test runs.
 */
function label(outcome: TerminalOutcome): TerminalOutcomeKind {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "timed-out";
    case "uncertain":
      return "uncertain";
    default:
      return assertNever(outcome, "unhandled terminal outcome");
  }
}

const EVERY_OUTCOME: readonly TerminalOutcome[] = [
  { kind: "completed" },
  { kind: "failed", effect: "none" },
  { kind: "cancelled", effect: "partial" },
  { kind: "timed-out", effect: "uncertain" },
  { kind: "uncertain", effect: "uncertain" },
];

describe("terminal outcomes", () => {
  test("the union covers exactly the declared kinds", () => {
    expect(EVERY_OUTCOME.map(label)).toEqual([...TERMINAL_OUTCOME_KINDS]);
  });

  test("recognizes every declared kind", () => {
    for (const kind of TERMINAL_OUTCOME_KINDS) {
      expect(isTerminalOutcomeKind(kind)).toBe(true);
    }
  });

  test("rejects an undeclared kind rather than widening it", () => {
    expect(isTerminalOutcomeKind("succeeded")).toBe(false);
    expect(isTerminalOutcomeKind(undefined)).toBe(false);
  });

  test("completed implies a completed effect", () => {
    expect(effectOf({ kind: "completed" })).toBe("completed");
  });

  test("uncertain can never claim a settled effect", () => {
    expect(effectOf({ kind: "uncertain", effect: "uncertain" })).toBe("uncertain");
  });

  test("cancellation carries its own effect certainty", () => {
    expect(effectOf({ kind: "cancelled", effect: "none" })).toBe("none");
    expect(effectOf({ kind: "cancelled", effect: "uncertain" })).toBe("uncertain");
  });

  test("partial and uncertain effects require inspection before retry", () => {
    expect(requiresInspection({ kind: "timed-out", effect: "uncertain" })).toBe(true);
    expect(requiresInspection({ kind: "failed", effect: "partial" })).toBe(true);
    expect(requiresInspection({ kind: "failed", effect: "none" })).toBe(false);
    expect(requiresInspection({ kind: "completed" })).toBe(false);
  });

  test("declares the effect certainties", () => {
    expect([...EFFECT_CERTAINTIES]).toEqual(["none", "completed", "partial", "uncertain"]);
  });
});
