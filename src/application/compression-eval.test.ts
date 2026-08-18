/**
 * Compression evaluator: cancellation and lane-result mapping.
 */

import { describe, expect, test } from "bun:test";

import { ok } from "../domain/index.ts";
import { createCompactLanes } from "./compact-lanes.ts";
import { createCompressionEvaluator, observationFromCompact } from "./compression-eval.ts";

describe("createCompressionEvaluator", () => {
  test("scores a compact-model reduction without echoing projection text", () => {
    const lanes = createCompactLanes({
      compact() {
        return ok({ kind: "lossy", text: "short synthesis" });
      },
    });
    const source = `${"keep this narration visible for savings ".repeat(20)}`;
    const reduced = lanes.reduce({ text: source, compactUse: "evaluated" });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    const evaluator = createCompressionEvaluator();
    const scored = evaluator.evaluate(observationFromCompact(reduced.value, { latencyMs: 8 }));
    expect(scored.ok).toBe(true);
    if (!scored.ok) {
      return;
    }
    expect(scored.value.lane).toBe("compact-model");
    expect(scored.value.claimsExact).toBe(false);
    expect(scored.value.reversible).toBe(true);
    expect(scored.value.savings).toBe(true);
    expect(JSON.stringify(scored.value)).not.toContain("short synthesis");
    expect(JSON.stringify(scored.value)).not.toContain(source.slice(0, 24));
  });

  test("cancels before scoring", () => {
    const evaluator = createCompressionEvaluator();
    expect(evaluator.evaluate({ lane: "hush" }, AbortSignal.abort())).toEqual({
      ok: false,
      error: { kind: "compression-eval-port", code: "cancelled", field: "signal" },
    });
  });
});
