/**
 * Context ranking: score admitted evidence, then select with diversity.
 */

import { describe, expect, test } from "bun:test";

import { CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import { applyContextBudget } from "./context-budget.ts";
import {
  admitEvidenceCandidate,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
} from "./context-evidence.ts";
import {
  DEFAULT_CONTEXT_MAX_PER_ORIGIN,
  describeContextRankError,
  MAX_CONTEXT_RANK_QUERY_LENGTH,
  rankAndSelectContext,
} from "./context-rank.ts";

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

describe("rankAndSelectContext", () => {
  test("ranks instruction evidence ahead of a file", () => {
    const file = admit({ id: "ev-file", sourceKind: "file", origin: "src/a.ts" });
    const instruction = admit({
      id: "ev-instruction",
      sourceKind: "instruction",
      origin: "system",
    });
    const ranked = rankAndSelectContext([file, instruction]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected.map((item) => item.candidate.id)).toEqual([
      instruction.id,
      file.id,
    ]);
    expect(ranked.value.selected[0]?.reasons).toContain("instruction-priority");
  });

  test("matches the query against origin and never searches payload text", () => {
    const secretPayload = `mention note.ts ${SECRET}`;
    const missed = admit({
      id: "ev-miss",
      origin: "src/other.ts",
      payload: { kind: "inline", text: secretPayload },
      exactSource: {
        kind: "inline",
        digest: DIGEST,
        byteLength: new TextEncoder().encode(secretPayload).byteLength,
      },
    });
    const hit = admit({ id: "ev-hit", origin: "src/note.ts" });
    const ranked = rankAndSelectContext([missed, hit], { query: "note.ts" });
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected[0]?.candidate.id).toBe(hit.id);
    expect(ranked.value.selected[0]?.reasons).toContain("query-relevance");
    expect(ranked.value.selected[0]?.reasons.join(",")).not.toContain(SECRET);
    expect(JSON.stringify(ranked.value.omitted)).not.toContain(SECRET);
  });

  test("places pinned evidence first", () => {
    const background = admit({
      id: "ev-background",
      sourceKind: "instruction",
      origin: "system",
    });
    const pinned = admit({ id: "ev-pinned", origin: "src/pinned.ts" });
    const ranked = rankAndSelectContext([background, pinned], { pinnedIds: ["ev-pinned"] });
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected[0]?.candidate.id).toBe(pinned.id);
    expect(ranked.value.selected[0]?.reasons).toContain("pinned");
  });

  test("caps near-duplicate origins so independent support can remain", () => {
    const first = admit({ id: "ev-a", origin: "src/same.ts" });
    const second = admit({ id: "ev-b", origin: "src/same.ts" });
    const third = admit({ id: "ev-c", origin: "src/same.ts" });
    const other = admit({ id: "ev-d", origin: "src/other.ts" });
    const ranked = rankAndSelectContext([first, second, third, other]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    const selectedOrigins = ranked.value.selected.map((item) => item.candidate.origin);
    expect(selectedOrigins.filter((origin) => origin === "src/same.ts")).toHaveLength(
      DEFAULT_CONTEXT_MAX_PER_ORIGIN,
    );
    expect(selectedOrigins).toContain("src/other.ts");
    expect(ranked.value.omitted.some((entry) => entry.reason === "diversity")).toBe(true);
  });

  test("sorts live exact source ahead of stale lossy synthesis", () => {
    const stale = admit({
      id: "ev-stale",
      origin: "src/stale.ts",
      freshness: "stale",
      trust: "untrusted",
      fidelity: "lossy-synthesis",
      exactSource: null,
      lineage: ["compact"],
    });
    const live = admit({ id: "ev-live", origin: "src/live.ts" });
    const ranked = rankAndSelectContext([stale, live]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected[0]?.candidate.id).toBe(live.id);
  });

  test("breaks remaining ties toward lower retrieval cost", () => {
    const expensive = admit({ id: "ev-expensive", origin: "src/a.ts", retrievalCost: 80 });
    const cheap = admit({ id: "ev-cheap", origin: "src/b.ts", retrievalCost: 1 });
    const ranked = rankAndSelectContext([expensive, cheap]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected[0]?.candidate.id).toBe(cheap.id);
    expect(ranked.value.selected[0]?.reasons).toContain("cost");
  });

  test("omits overflow past the rank-limit without echoing origin", () => {
    const first = admit({ id: "ev-1", origin: "src/one.ts" });
    const second = admit({ id: "ev-2", origin: "src/two.ts" });
    const ranked = rankAndSelectContext([first, second], { maxSelected: 1 });
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    expect(ranked.value.selected).toHaveLength(1);
    expect(ranked.value.omitted).toEqual([{ id: second.id, reason: "rank-limit" }]);
    expect(JSON.stringify(ranked.value.omitted)).not.toContain("src/two.ts");
  });

  test("feeds selected order into the budget fill", () => {
    const file = admit({ id: "ev-file", origin: "src/a.ts" });
    const instruction = admit({
      id: "ev-instruction",
      sourceKind: "instruction",
      origin: "system",
    });
    const ranked = rankAndSelectContext([file, instruction]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) {
      return;
    }
    const budget = applyContextBudget(
      ranked.value.selected.map((item) => ({ candidate: item.candidate })),
    );
    expect(budget.ok).toBe(true);
    if (!budget.ok) {
      return;
    }
    expect(budget.value.included.map((item) => item.id)).toEqual([instruction.id, file.id]);
  });

  test("refuses an unknown destination without echoing the value", () => {
    const ranked = rankAndSelectContext([admit()], { destination: "remote-lab" });
    expect(ranked.ok).toBe(false);
    if (ranked.ok) {
      return;
    }
    expect(ranked.error).toEqual({
      kind: "context-rank",
      code: "unsupported",
      field: "destination",
    });
    expect(describeContextRankError(ranked.error)).toBe("unsupported destination");
    expect(describeContextRankError(ranked.error)).not.toContain("remote-lab");
  });

  test("refuses a query that exceeds the length cap", () => {
    const ranked = rankAndSelectContext([admit()], {
      query: "n".repeat(MAX_CONTEXT_RANK_QUERY_LENGTH + 1),
    });
    expect(ranked.ok).toBe(false);
    if (ranked.ok) {
      return;
    }
    expect(ranked.error.code).toBe("oversized");
    expect(ranked.error.field).toBe("query");
  });

  test("refuses duplicate candidate ids", () => {
    const candidate = admit();
    const ranked = rankAndSelectContext([candidate, candidate]);
    expect(ranked.ok).toBe(false);
    if (ranked.ok) {
      return;
    }
    expect(ranked.error).toEqual({ kind: "context-rank", code: "malformed", field: "candidates" });
  });
});
