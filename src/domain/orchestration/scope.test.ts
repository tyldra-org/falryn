import { describe, expect, test } from "bun:test";

import { EFFECT_CERTAINTIES, type EffectCertainty } from "./outcome.ts";
import {
  cancellationOutcomeFor,
  effectSeverity,
  isScopeKind,
  SCOPE_KINDS,
  timeoutOutcomeFor,
  worstEffect,
} from "./scope.ts";

describe("scope kinds", () => {
  test("cover the runtime ownership chain in order", () => {
    expect([...SCOPE_KINDS]).toEqual([
      "application",
      "session",
      "turn",
      "attempt",
      "invocation",
      "child",
    ]);
  });

  test("refuse an undeclared kind", () => {
    expect(isScopeKind("workspace")).toBe(false);
    expect(isScopeKind(null)).toBe(false);
  });
});

describe("effect severity", () => {
  test("ranks uncertainty above every settled effect", () => {
    expect(effectSeverity("uncertain")).toBeGreaterThan(effectSeverity("partial"));
    expect(effectSeverity("partial")).toBeGreaterThan(effectSeverity("completed"));
    expect(effectSeverity("completed")).toBeGreaterThan(effectSeverity("none"));
  });

  test("worstEffect is commutative and never lowers an effect", () => {
    for (const left of EFFECT_CERTAINTIES) {
      for (const right of EFFECT_CERTAINTIES) {
        const worst = worstEffect(left, right);
        expect(worst).toBe(worstEffect(right, left));
        expect(effectSeverity(worst)).toBeGreaterThanOrEqual(effectSeverity(left));
        expect(effectSeverity(worst)).toBeGreaterThanOrEqual(effectSeverity(right));
      }
    }
  });
});

describe("cancellation outcomes", () => {
  test("a scope that changed nothing is honestly cancelled", () => {
    expect(cancellationOutcomeFor("none")).toEqual({ kind: "cancelled", effect: "none" });
  });

  test.each<EffectCertainty>(["partial", "uncertain"])(
    "a scope with a %s effect is uncertain, not cancelled",
    (effect) => {
      expect(cancellationOutcomeFor(effect)).toEqual({ kind: "uncertain", effect: "uncertain" });
    },
  );

  test("a completed effect is not erased by cancellation", () => {
    expect(cancellationOutcomeFor("completed")).toEqual({
      kind: "cancelled",
      effect: "completed",
    });
  });
});

describe("timeout outcomes", () => {
  test("name the expiry rather than reporting a plain cancellation", () => {
    expect(timeoutOutcomeFor("none")).toEqual({ kind: "timed-out", effect: "none" });
  });

  test.each<EffectCertainty>(["partial", "uncertain"])(
    "a %s effect makes a timeout's effect uncertain",
    (effect) => {
      expect(timeoutOutcomeFor(effect)).toEqual({ kind: "timed-out", effect: "uncertain" });
    },
  );

  test("a timeout is never reported as completed", () => {
    for (const effect of EFFECT_CERTAINTIES) {
      expect(timeoutOutcomeFor(effect).kind).toBe("timed-out");
    }
  });
});
