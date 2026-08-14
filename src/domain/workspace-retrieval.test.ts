import { describe, expect, test } from "bun:test";
import { localPath } from "./filesystem.ts";
import { ok } from "./result.ts";
import type { RetrievalHit } from "./workspace-retrieval.ts";
import {
  assembleContextPack,
  cosineSimilarity,
  describeWorkspaceRetrievalError,
  diversifyHits,
  dominantConfidence,
  embeddingRecordKey,
  MAX_RETRIEVAL_QUERY_LENGTH,
  parseWorkspaceRetrievalQuery,
  SEMANTIC_BASELINE,
  scoreIndexRecords,
} from "./workspace-retrieval.ts";

describe("parseWorkspaceRetrievalQuery", () => {
  test("applies defaults for an omitted destination and include glob", () => {
    const parsed = parseWorkspaceRetrievalQuery({ query: "Token" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected query");
    }
    expect(parsed.value.destination).toBe("local");
    expect(parsed.value.allowRemote).toBe(false);
    expect(parsed.value.include).toHaveLength(1);
    expect(parsed.value.include[0]?.pattern).toBe("*");
    expect(parsed.value.includeHidden).toBe(false);
    expect(parsed.value.caseSensitive).toBe(true);
    expect(parsed.value.maxMatches).toBe(20);
    expect(parsed.value.maxPackItems).toBe(8);
    expect(parsed.value.maxEstimatedTokens).toBe(2048);
  });

  test("rejects a query that contains a secret without echoing it", () => {
    const empty = parseWorkspaceRetrievalQuery({ query: "" });
    expect(empty).toEqual({ ok: false, error: { code: "malformed-query", reason: "empty" } });
    const tooLong = parseWorkspaceRetrievalQuery({
      query: "a".repeat(MAX_RETRIEVAL_QUERY_LENGTH + 1),
    });
    expect(tooLong).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "too-long" },
    });
    expect(JSON.stringify(tooLong)).not.toContain("aaaa");
    const nul = parseWorkspaceRetrievalQuery({ query: "sk-live-SECRET\0" });
    expect(nul).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "illegal-character" },
    });
    expect(JSON.stringify(nul)).not.toContain("sk-live-SECRET");
  });

  test("rejects malformed destinations and limits", () => {
    expect(parseWorkspaceRetrievalQuery({ query: "token", destination: "cloud" })).toEqual({
      ok: false,
      error: { code: "malformed-destination" },
    });
    expect(parseWorkspaceRetrievalQuery({ query: "token", maxMatches: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxMatches", reason: "not-positive" },
    });
    expect(parseWorkspaceRetrievalQuery({ query: "token", maxPackItems: 99 })).toEqual({
      ok: false,
      error: { code: "malformed-limit", field: "maxPackItems", reason: "above-hard-maximum" },
    });
  });
});

describe("cosineSimilarity", () => {
  test("scores aligned vectors and rejects dimension mismatch", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineSimilarity([], [])).toBeNull();
  });
});

describe("scoreIndexRecords", () => {
  test("keeps lexical, structural, and semantic scores separate", () => {
    const parsed = parseWorkspaceRetrievalQuery({ query: "foo" });
    if (!parsed.ok) {
      throw new Error("expected query");
    }
    const record = {
      logical: "src/a.ts",
      kind: "symbol" as const,
      name: "foo",
      text: "export function foo() { return token; }",
      startLine: 1,
      endLine: 1,
      revision: "rev-a",
    };
    const embedding = {
      logical: "src/a.ts",
      kind: "symbol" as const,
      name: "foo",
      startLine: 1,
      endLine: 1,
      digest: "d1",
      chunkerVersion: "chunker/v1",
      provider: "test",
      model: "toy",
      dimensions: 2,
      normalization: "l2" as const,
      destination: "local" as const,
      vector: [1, 0],
    };
    const scored = scoreIndexRecords(
      [record],
      parsed.value,
      [1, 0],
      new Map([[embeddingRecordKey(embedding), embedding]]),
    );
    expect(scored.attempt).toBe("used");
    expect(scored.scored).toHaveLength(1);
    expect(scored.scored[0]?.scores.lexical).toBe(1);
    expect(scored.scored[0]?.scores.structural).toBe(1);
    expect(scored.scored[0]?.scores.semantic).toBeCloseTo(1);
    expect(scored.scored[0]?.scores.fused).toBeGreaterThan(0);
  });

  test("falls back when semantic similarity is below baseline", () => {
    const parsed = parseWorkspaceRetrievalQuery({ query: "foo" });
    if (!parsed.ok) {
      throw new Error("expected query");
    }
    const embedding = {
      logical: "src/a.ts",
      kind: "symbol" as const,
      name: "foo",
      startLine: 1,
      endLine: 1,
      digest: "d1",
      chunkerVersion: "chunker/v1",
      provider: "test",
      model: "toy",
      dimensions: 2,
      normalization: "l2" as const,
      destination: "local" as const,
      vector: [0, 1],
    };
    const scored = scoreIndexRecords(
      [
        {
          logical: "src/a.ts",
          kind: "symbol",
          name: "foo",
          text: "foo",
          startLine: 1,
          endLine: 1,
          revision: "rev-a",
        },
      ],
      parsed.value,
      [1, 0],
      new Map([[embeddingRecordKey(embedding), embedding]]),
    );
    expect(scored.attempt).toBe("below-baseline");
    expect(scored.scored[0]?.scores.semantic).toBe(0);
    expect(scored.scored[0]?.scores.lexical).toBe(1);
    expect(SEMANTIC_BASELINE).toBeGreaterThan(0);
  });
});

describe("assembleContextPack", () => {
  test("marks the first hit primary and later hits support", () => {
    const resolved = localPath("/work/project/src/a.ts");
    const hit = (name: string, line: number): RetrievalHit => ({
      logical: "src/a.ts",
      resolved,
      kind: "symbol",
      name,
      excerpt: name,
      startLine: line,
      endLine: line,
      freshness: "current",
      scores: { lexical: 1, structural: 1, semantic: 0.9, fused: 0.05 },
      generation: "gen-1",
    });
    const pack = assembleContextPack([hit("foo", 1), hit("bar", 20)], 8, 2048);
    expect(pack.items[0]?.role).toBe("primary");
    expect(pack.items[1]?.role).toBe("support");
    expect(pack.items[0]?.fidelity).toBe("exact");
    expect(pack.items[0]?.expansion.kind).toBe("read-range");
    expect(dominantConfidence(hit("foo", 1).scores)).toBe("structural");
  });
});

describe("diversifyHits", () => {
  test("caps near-duplicate hits on the same path", () => {
    const resolved = localPath("/work/project/src/a.ts");
    const hit = (line: number): RetrievalHit => ({
      logical: "src/a.ts",
      resolved,
      kind: "chunk",
      name: `n${line}`,
      excerpt: "foo",
      startLine: line,
      endLine: line,
      freshness: "current",
      scores: { lexical: 1, structural: 0, semantic: 0, fused: 1 / line },
      generation: "gen-1",
    });
    const kept = diversifyHits([hit(1), hit(2), hit(20)]);
    expect(kept.map((row) => row.startLine)).toEqual([1, 20]);
  });
});

describe("describeWorkspaceRetrievalError", () => {
  test("never echoes rejected query text", () => {
    const described = describeWorkspaceRetrievalError({
      code: "malformed-query",
      reason: "illegal-character",
    });
    expect(described).toBe("malformed-query:illegal-character");
    expect(ok("sk-live-SECRET")).toEqual({ ok: true, value: "sk-live-SECRET" });
  });
});
