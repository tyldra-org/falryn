/**
 * Compression evaluation tests for fidelity, reversibility, latency, and savings.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  COMPRESSION_EVAL_VERSION,
  evaluateCompression,
  evaluateCompressionRun,
} from "./compression-eval.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const OTHER = `${CONTENT_DIGEST_ALGORITHM}:${"b".repeat(64)}`;

function observation(overrides: Record<string, unknown> = {}) {
  return {
    lane: "compact-model",
    fidelity: "lossy-synthesis",
    claimsExact: false,
    complete: false,
    sourceBytes: 400,
    reducedBytes: 80,
    overheadBytes: 16,
    originalDigest: DIGEST,
    expansionDigest: DIGEST,
    tokenKind: "estimated",
    sourceTokens: 100,
    reducedTokens: 20,
    overheadTokens: 4,
    latencyMs: 12,
    latencyBudgetMs: 1_000,
    ...overrides,
  };
}

describe("evaluateCompression", () => {
  test("lossy synthesis with expansion is reversible and never exact-source", () => {
    const result = evaluateCompression(observation());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.strategyVersion).toBe(COMPRESSION_EVAL_VERSION);
    expect(result.value.fidelityVerdict).toBe("faithful");
    expect(result.value.claimsExact).toBe(false);
    expect(result.value.reversible).toBe(true);
    expect(result.value.recovery).toBe("expansion");
    expect(result.value.savings).toBe(true);
    expect(result.value.netTokens).toBe(76);
    expect(result.value.netBytes).toBe(304);
    expect(result.value.latencyVerdict).toBe("within-budget");
  });

  test("extractive or lossy claimsExact is a fidelity violation", () => {
    expect(evaluateCompression(observation({ claimsExact: true }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "fidelity-violation", field: "claimsExact" },
    });
    expect(
      evaluateCompression(observation({ fidelity: "extractive-summary", claimsExact: true })),
    ).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "fidelity-violation", field: "claimsExact" },
    });
  });

  test("exact-source passthrough requires a matching expansion digest", () => {
    const result = evaluateCompression(
      observation({
        lane: "structural",
        fidelity: "exact-source",
        claimsExact: true,
        complete: true,
        reducedBytes: 400,
        reducedTokens: 100,
        overheadBytes: 0,
        overheadTokens: 0,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.recovery).toBe("exact-source");
    expect(result.value.savings).toBe(false);
  });

  test("missing or disagreeing expansion fails closed", () => {
    expect(evaluateCompression(observation({ expansionDigest: null }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "irreversible", field: "expansionDigest" },
    });
    expect(evaluateCompression(observation({ expansionDigest: OTHER }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "digest-mismatch", field: "expansionDigest" },
    });
  });

  test("cancelled, timed-out, restricted, and stale cache fail closed", () => {
    expect(evaluateCompression(observation({ cancelled: true }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "cancelled", field: "signal" },
    });
    expect(evaluateCompression(observation({ timedOut: true }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "timed-out", field: "latencyMs" },
    });
    expect(evaluateCompression(observation({ latencyMs: 2_000, latencyBudgetMs: 1_000 }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "timed-out", field: "latencyMs" },
    });
    expect(evaluateCompression(observation({ sensitivity: "restricted" }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "secret", field: "sensitivity" },
    });
    expect(evaluateCompression(observation({ sourceGeneration: 2, cachedGeneration: 1 }))).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "stale-cache", field: "cachedGeneration" },
    });
  });

  test("overhead can erase gross reduction so savings is false", () => {
    const result = evaluateCompression(
      observation({ reducedBytes: 390, reducedTokens: 98, overheadBytes: 20, overheadTokens: 5 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.savings).toBe(false);
    expect(result.value.netBytes).toBe(-10);
  });
});

describe("evaluateCompressionRun", () => {
  test("sums same-kind observations and refuses mixed token kinds", () => {
    const run = evaluateCompressionRun({
      observations: [
        observation({ lane: "hush", fidelity: "deterministic-transform" }),
        observation({
          lane: "loom",
          fidelity: "exact-source",
          claimsExact: true,
          complete: true,
          sourceBytes: 200,
          reducedBytes: 200,
          overheadBytes: 0,
          sourceTokens: 50,
          reducedTokens: 50,
          overheadTokens: 0,
        }),
      ],
    });
    expect(run.ok).toBe(true);
    if (!run.ok) {
      return;
    }
    expect(run.value.tokenKind).toBe("estimated");
    expect(run.value.observationCount).toBe(2);
    expect(run.value.netTokens).toBe(76);
    expect(run.value.savings).toBe(true);

    expect(
      evaluateCompressionRun({
        observations: [observation(), observation({ tokenKind: "provider-reported" })],
      }),
    ).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "mixed-token-kinds", field: "tokenKind" },
    });
  });

  test("empty and oversized batches are refused", () => {
    expect(evaluateCompressionRun({ observations: [] })).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "empty", field: "observations" },
    });
    const oversized = Array.from({ length: 33 }, () => observation());
    expect(evaluateCompressionRun({ observations: oversized })).toEqual({
      ok: false,
      error: { kind: "compression-eval", code: "oversized", field: "observations" },
    });
  });
});
