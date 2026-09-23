import { describe, expect, test } from "bun:test";
import type { GenerationRate } from "../../domain/sessions/index.ts";
import {
  GENERATION_RATE_LABEL_WIDTH,
  type GenerationRatePhase,
  generationRateLabel,
} from "./generation-rate.ts";

const rates: readonly GenerationRate[] = [
  { kind: "measured", tokensPerSecond: 9, source: "estimate" },
  { kind: "measured", tokensPerSecond: 42.4, source: "provider-reported" },
  { kind: "measured", tokensPerSecond: 1_234_567, source: "estimate" },
  { kind: "insufficient-sample", source: "estimate" },
  { kind: "insufficient-sample", source: "provider-reported" },
  { kind: "unknown" },
  { kind: "unavailable", reason: "clock-anomaly" },
];
const phases: readonly GenerationRatePhase[] = ["live", "complete", "partial"];

describe("generation rate label", () => {
  test("every rate and phase occupies the same width, so updates never shift text", () => {
    for (const rate of rates) {
      for (const phase of phases) {
        expect(generationRateLabel(rate, phase)).toHaveLength(GENERATION_RATE_LABEL_WIDTH);
      }
    }
  });

  test("estimates, live values, partial streams and gaps are named in words", () => {
    const label = (rate: GenerationRate, phase: GenerationRatePhase) =>
      generationRateLabel(rate, phase).trimEnd();
    expect(label({ kind: "measured", tokensPerSecond: 42, source: "estimate" }, "live")).toBe(
      "   42 tok/s est. live",
    );
    expect(
      label({ kind: "measured", tokensPerSecond: 42.4, source: "provider-reported" }, "complete"),
    ).toBe("   42 tok/s");
    expect(
      label({ kind: "measured", tokensPerSecond: 40, source: "provider-reported" }, "partial"),
    ).toBe("   40 tok/s partial");
    expect(label({ kind: "insufficient-sample", source: "estimate" }, "complete")).toBe(
      "    - tok/s est. low-sample",
    );
    expect(label({ kind: "unknown" }, "complete")).toBe("    ? tok/s unknown");
    expect(label({ kind: "unavailable", reason: "clock-anomaly" }, "partial")).toBe(
      "    - tok/s partial unavailable",
    );
  });
});
