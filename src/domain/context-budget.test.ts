/**
 * Context budget accounting: reserve output/tool framing, then fill evidence.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  applyContextBudget,
  DEFAULT_CONTEXT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_CONTEXT_RESERVED_TOOL_FRAMING_TOKENS,
  describeContextBudgetError,
  HARD_CONTEXT_MAX_ITEMS,
  parseContextBudgetProfile,
} from "./context-budget.ts";
import {
  admitEvidenceCandidate,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
} from "./context-evidence.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
const TEXT = "export const ok = true;\n";
const TEXT_BYTES = new TextEncoder().encode(TEXT).byteLength;

function admit(overrides: Partial<EvidenceCandidateInput> = {}): EvidenceCandidate {
  const result = admitEvidenceCandidate({
    id: "ev-1",
    sourceKind: "file",
    origin: "src/main.ts",
    workspaceId: "ws-1",
    payload: { kind: "inline", text: TEXT },
    estimatedTokens: 8,
    freshness: "live",
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: "exact-source",
    exactSource: { kind: "inline", digest: DIGEST, byteLength: TEXT_BYTES },
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`admit failed: ${result.error.code}`);
  }
  return result.value;
}

function expansion() {
  return {
    kind: "artifact" as const,
    artifactId: "source-1",
    digest: DIGEST,
    byteLength: 2048,
  };
}

describe("parseContextBudgetProfile", () => {
  test("applies defaults and reserves output before evidence room exists", () => {
    const parsed = parseContextBudgetProfile();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.destination).toBe("model");
    expect(parsed.value.reservedOutputTokens).toBe(DEFAULT_CONTEXT_RESERVED_OUTPUT_TOKENS);
    expect(parsed.value.reservedToolFramingTokens).toBe(
      DEFAULT_CONTEXT_RESERVED_TOOL_FRAMING_TOKENS,
    );
    expect(
      parsed.value.maxTotalTokens -
        parsed.value.reservedOutputTokens -
        parsed.value.reservedToolFramingTokens,
    ).toBeGreaterThan(0);
  });

  test("refuses a reservation larger than the total token budget", () => {
    const parsed = parseContextBudgetProfile({
      maxTotalTokens: 100,
      reservedOutputTokens: 80,
      reservedToolFramingTokens: 40,
    });
    expect(parsed).toEqual({
      ok: false,
      error: {
        kind: "context-budget",
        code: "reservation-exceeds-total",
        field: "reservedOutputTokens",
      },
    });
    if (!parsed.ok) {
      expect(describeContextBudgetError(parsed.error)).toBe("reservation exceeds total tokens");
    }
  });

  test("refuses an unknown destination without echoing the value", () => {
    const parsed = parseContextBudgetProfile({ destination: SECRET });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });
});

describe("applyContextBudget", () => {
  test("reserves output and tool framing before filling evidence", () => {
    const plan = applyContextBudget([{ candidate: admit() }], {
      maxTotalTokens: 100,
      reservedOutputTokens: 40,
      reservedToolFramingTokens: 10,
      maxItemTokens: 50,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.reservedOutputTokens).toBe(40);
    expect(plan.value.reservedToolFramingTokens).toBe(10);
    expect(plan.value.included).toHaveLength(1);
    expect(plan.value.remainingTokens).toBe(42);
    expect(plan.value.pressure).toEqual([]);
    expect(plan.value.insufficient).toBeNull();
  });

  test("omits sensitive evidence from a model destination", () => {
    const plan = applyContextBudget([
      { candidate: admit({ id: "ev-sensitive", sensitivity: "sensitive" }) },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.included).toEqual([]);
    expect(plan.value.omitted).toEqual([
      {
        id: admit({ id: "ev-sensitive", sensitivity: "sensitive" }).id,
        reason: "destination-ineligible",
      },
    ]);
    expect(plan.value.pressure).toEqual(["sensitivity"]);
  });

  test("omits restricted evidence as secret without echoing payload text", () => {
    const secretBytes = new TextEncoder().encode(SECRET).byteLength;
    const candidate = admit({
      id: "ev-secret",
      sensitivity: "user-content",
      origin: "src/note.ts",
      payload: { kind: "inline", text: SECRET },
      exactSource: { kind: "inline", digest: DIGEST, byteLength: secretBytes },
    });
    const restricted = { ...candidate, sensitivity: "restricted" as const };
    const plan = applyContextBudget([{ candidate: restricted }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.omitted[0]?.reason).toBe("secret");
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  test("omits an item that exceeds the per-item token cap", () => {
    const plan = applyContextBudget([{ candidate: admit({ estimatedTokens: 20 }) }], {
      maxItemTokens: 8,
      maxTotalTokens: 200,
      reservedOutputTokens: 10,
      reservedToolFramingTokens: 10,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.omitted).toEqual([{ id: admit().id, reason: "item-limit" }]);
    expect(plan.value.included).toEqual([]);
  });

  test("under token pressure removes duplicate origins first", () => {
    const first = admit({ id: "ev-1", origin: "src/main.ts", estimatedTokens: 40 });
    const duplicate = admit({ id: "ev-2", origin: "src/main.ts", estimatedTokens: 40 });
    const other = admit({
      id: "ev-3",
      origin: "src/other.ts",
      estimatedTokens: 40,
    });
    const plan = applyContextBudget(
      [{ candidate: first }, { candidate: duplicate }, { candidate: other }],
      {
        maxTotalTokens: 130,
        reservedOutputTokens: 40,
        reservedToolFramingTokens: 10,
        maxItemTokens: 50,
        maxItems: 8,
      },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.appliedActions).toEqual(["remove-duplication"]);
    expect(plan.value.omitted).toEqual([{ id: duplicate.id, reason: "duplicate" }]);
    expect(plan.value.included.map((item) => item.id)).toEqual([first.id, other.id]);
  });

  test("under pressure defers expansion-bearing evidence after duplicates", () => {
    const exact = admit({ id: "ev-1", origin: "a.ts", estimatedTokens: 40 });
    const retrievable = admit({
      id: "ev-2",
      origin: "b.ts",
      estimatedTokens: 40,
      expansion: expansion(),
    });
    const plan = applyContextBudget([{ candidate: exact }, { candidate: retrievable }], {
      maxTotalTokens: 90,
      reservedOutputTokens: 40,
      reservedToolFramingTokens: 10,
      maxItemTokens: 50,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.appliedActions).toEqual(["remove-duplication", "defer-retrievable"]);
    expect(plan.value.omitted).toEqual([{ id: retrievable.id, reason: "deferred-retrievable" }]);
    expect(plan.value.included.map((item) => item.id)).toEqual([exact.id]);
  });

  test("under pressure drops lossy projections before exact source", () => {
    const exact = admit({ id: "ev-1", origin: "a.ts", estimatedTokens: 40 });
    const lossy = admit({
      id: "ev-2",
      origin: "b.ts",
      estimatedTokens: 40,
      fidelity: "lossy-synthesis",
      exactSource: null,
      lineage: ["compact"],
    });
    const plan = applyContextBudget([{ candidate: exact }, { candidate: lossy }], {
      maxTotalTokens: 90,
      reservedOutputTokens: 40,
      reservedToolFramingTokens: 10,
      maxItemTokens: 50,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.appliedActions).toContain("prefer-deterministic");
    expect(plan.value.omitted).toEqual([{ id: lossy.id, reason: "lossy-projection" }]);
    expect(plan.value.included.map((item) => item.id)).toEqual([exact.id]);
  });

  test("enforces a latency budget", () => {
    const plan = applyContextBudget(
      [
        { candidate: admit({ id: "ev-1" }), latencyMs: 8 },
        { candidate: admit({ id: "ev-2", origin: "src/other.ts" }), latencyMs: 8 },
      ],
      {
        maxLatencyMs: 10,
        maxTotalTokens: 200,
        reservedOutputTokens: 10,
        reservedToolFramingTokens: 10,
      },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.omitted).toEqual([
      { id: admit({ id: "ev-2", origin: "src/other.ts" }).id, reason: "latency-limit" },
    ]);
    expect(plan.value.pressure).toContain("latency");
  });

  test("enforces a per-source-class item cap", () => {
    const plan = applyContextBudget(
      [
        { candidate: admit({ id: "ev-1", origin: "a.ts" }) },
        { candidate: admit({ id: "ev-2", origin: "b.ts" }) },
      ],
      {
        sourceClass: { file: { maxItems: 1 } },
      },
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.omitted).toEqual([
      { id: admit({ id: "ev-2", origin: "b.ts" }).id, reason: "source-class-limit" },
    ]);
  });

  test("reports insufficient context when a required charge is omitted", () => {
    const required = admit({ id: "ev-required", estimatedTokens: 80 });
    const plan = applyContextBudget([{ candidate: required, required: true }], {
      maxTotalTokens: 100,
      reservedOutputTokens: 20,
      reservedToolFramingTokens: 10,
      maxItemTokens: 40,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.included).toEqual([]);
    expect(plan.value.omitted[0]?.reason).toBe("item-limit");
    expect(plan.value.insufficient?.kind).toBe("insufficient-context");
    expect(plan.value.insufficient?.recoveries).toContain("narrower-task");
    expect(plan.value.insufficient?.recoveries).toContain("different-model");
  });

  test("does not rewrite excerpts and keeps stale freshness on included items", () => {
    const stale = admit({ id: "ev-stale", freshness: "stale" });
    const plan = applyContextBudget([{ candidate: stale }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.value.included[0]?.freshness).toBe("stale");
    expect(plan.value.included[0]?.payload).toEqual(stale.payload);
  });

  test("refuses an oversized charge list", () => {
    const charges = Array.from({ length: HARD_CONTEXT_MAX_ITEMS + 1 }, (_, index) => ({
      candidate: admit({ id: `ev-${index + 1}`, origin: `src/${index}.ts` }),
    }));
    const plan = applyContextBudget(charges);
    expect(plan).toEqual({
      ok: false,
      error: { kind: "context-budget", code: "oversized", field: "charges" },
    });
  });
});
