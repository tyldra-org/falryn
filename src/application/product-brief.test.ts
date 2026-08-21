/**
 * Product Brief controls (#717).
 */

import { describe, expect, test } from "bun:test";

import { configurationGeneration, sessionId, turnId } from "../domain/index.ts";
import { composeProductBriefControls, PRODUCT_BRIEF_OWNER } from "./product-brief.ts";

describe("composeProductBriefControls", () => {
  test("projects user verbosity into a required brief section", () => {
    const brief = composeProductBriefControls({ initialVerbosity: "compact" });
    expect(brief.owner).toBe(PRODUCT_BRIEF_OWNER);
    expect(brief.getVerbosity()).toBe("compact");
    const projected = brief.projectForTurn({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      configurationGeneration: configurationGeneration.from(0),
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) {
      return;
    }
    expect(projected.value.section.role).toBe("brief");
    expect(projected.value.projection.receipt.requestedMode).toBe("compact");
  });

  test("rejects unsupported verbosity modes", () => {
    const brief = composeProductBriefControls();
    const set = brief.setVerbosity("loud");
    expect(set.ok).toBe(false);
    expect(brief.getVerbosity()).toBe("balanced");
  });
});
