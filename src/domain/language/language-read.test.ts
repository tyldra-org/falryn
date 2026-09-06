import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LANGUAGE_READ_LIMITS,
  describeLanguageReadError,
  languageReadLimits,
  normalizeLanguageBackendSymbolOutcome,
  parseLanguageChangedRegionsReadRequest,
  parseLanguageSymbolReadRequest,
} from "./index.ts";

describe("language-read contracts", () => {
  test("applies bounded defaults and rejects limits above hard caps", () => {
    expect(languageReadLimits()).toEqual({ ok: true, value: DEFAULT_LANGUAGE_READ_LIMITS });
    expect(languageReadLimits({ maxRegions: 257 })).toEqual({
      ok: false,
      error: { code: "limit-too-large", field: "maxRegions", maximum: 256 },
    });
  });

  test("normalizes a symbol request and rejects a related-evidence cap", () => {
    const parsed = parseLanguageSymbolReadRequest({
      path: "src/app.ts",
      symbol: "main",
      related: ["signature", "caller"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("expected a valid symbol request");
    }
    expect(parsed.value.limits).toEqual(DEFAULT_LANGUAGE_READ_LIMITS);

    expect(
      parseLanguageSymbolReadRequest({
        path: "src/app.ts",
        symbol: "main",
        related: ["signature", "caller"],
        limits: { maxRelatedEvidence: 1 },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "capped",
        limit: "maxRelatedEvidence",
        requested: 2,
        maximum: 1,
      },
    });
  });

  test("defaults changed-region comparison to the working tree", () => {
    expect(parseLanguageChangedRegionsReadRequest({ paths: ["src/app.ts"] })).toMatchObject({
      ok: true,
      value: {
        comparison: { kind: "working-tree" },
        paths: ["src/app.ts"],
      },
    });
  });

  test("rejects lexical evidence that claims semantic certainty", () => {
    const outcome = normalizeLanguageBackendSymbolOutcome({
      status: "found",
      value: {
        document: { path: "src/app.ts", version: 1, generation: "g1" },
        symbol: {
          name: "main",
          kind: "function",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
        },
        related: [],
        provenance: {
          backend: "lexical",
          generation: "g1",
          confidence: "semantic",
          fallback: true,
        },
        omissions: [],
      },
    });
    expect(outcome).toEqual({
      ok: false,
      error: { code: "malformed-backend", field: "provenance" },
    });
  });

  test("describes typed errors without including rejected values", () => {
    expect(
      describeLanguageReadError({
        code: "stale",
        expectedGeneration: "g1",
        actualGeneration: "g2",
      }),
    ).toBe("stale:g1:g2");
  });
});
