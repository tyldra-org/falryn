import { describe, expect, test } from "bun:test";
import {
  qualifyEmbeddings,
  qualifyStructuralParsing,
  SEMANTIC_BASELINE,
  STRUCTURAL_PARSE_MIN_FILE_BYTES,
} from "./language-intelligence-qualify.ts";
import {
  buildIndexGeneration,
  extractIndexRecordsFromText,
  languageIdFromLogical,
  mergeLexicalWithStructuralSymbols,
} from "./workspace-index-build.ts";

describe("qualifyEmbeddings", () => {
  test("skips when unavailable, denied, disabled, or below baseline", () => {
    expect(
      qualifyEmbeddings({
        available: false,
        destination: "local",
        allowRemote: true,
        maxSimilarity: 1,
        lexicalHitCount: 0,
        structuralHitCount: 0,
      }).reason,
    ).toBe("unavailable");
    expect(
      qualifyEmbeddings({
        available: true,
        destination: "remote",
        allowRemote: false,
        maxSimilarity: 1,
        lexicalHitCount: 0,
        structuralHitCount: 0,
      }).reason,
    ).toBe("denied");
    expect(
      qualifyEmbeddings({
        available: true,
        destination: "local",
        allowRemote: true,
        maxSimilarity: SEMANTIC_BASELINE - 0.01,
        lexicalHitCount: 0,
        structuralHitCount: 0,
        disabled: true,
      }).reason,
    ).toBe("disabled");
    expect(
      qualifyEmbeddings({
        available: true,
        destination: "local",
        allowRemote: true,
        maxSimilarity: SEMANTIC_BASELINE - 0.01,
        lexicalHitCount: 2,
        structuralHitCount: 1,
      }),
    ).toEqual({
      capability: "embeddings",
      decision: "skip",
      reason: "below-baseline",
    });
  });

  test("uses embeddings when similarity clears the lexical/symbol floor", () => {
    expect(
      qualifyEmbeddings({
        available: true,
        destination: "local",
        allowRemote: false,
        maxSimilarity: SEMANTIC_BASELINE,
        lexicalHitCount: 3,
        structuralHitCount: 2,
      }),
    ).toEqual({
      capability: "embeddings",
      decision: "use",
      reason: "justified",
    });
  });
});

describe("qualifyStructuralParsing", () => {
  test("skips when parser missing, language unsupported, tiny file, or regex already found symbols", () => {
    expect(
      qualifyStructuralParsing({
        parserAvailable: false,
        languageId: "typescript",
        regexSymbolCount: 0,
        fileBytes: 1_000,
      }).reason,
    ).toBe("unavailable");
    expect(
      qualifyStructuralParsing({
        parserAvailable: true,
        languageId: "markdown",
        regexSymbolCount: 0,
        fileBytes: 1_000,
      }).reason,
    ).toBe("not-justified");
    expect(
      qualifyStructuralParsing({
        parserAvailable: true,
        languageId: "typescript",
        regexSymbolCount: 0,
        fileBytes: STRUCTURAL_PARSE_MIN_FILE_BYTES - 1,
      }).reason,
    ).toBe("not-justified");
    expect(
      qualifyStructuralParsing({
        parserAvailable: true,
        languageId: "typescript",
        regexSymbolCount: 2,
        fileBytes: 1_000,
      }).reason,
    ).toBe("not-justified");
  });

  test("uses structural parsing when regex finds no symbols on a supported language file", () => {
    expect(
      qualifyStructuralParsing({
        parserAvailable: true,
        languageId: "typescript",
        regexSymbolCount: 0,
        fileBytes: STRUCTURAL_PARSE_MIN_FILE_BYTES,
      }),
    ).toEqual({
      capability: "structural-parsing",
      decision: "use",
      reason: "justified",
    });
  });

  test("force admits even when regex already found symbols", () => {
    expect(
      qualifyStructuralParsing({
        parserAvailable: true,
        languageId: null,
        regexSymbolCount: 5,
        fileBytes: 10,
        force: true,
      }).decision,
    ).toBe("use");
  });
});

describe("structural merge and language id", () => {
  test("maps common extensions and merges structural symbols over regex symbols", () => {
    expect(languageIdFromLogical("src/a.ts")).toBe("typescript");
    expect(languageIdFromLogical("README.md")).toBeNull();

    const lexical = extractIndexRecordsFromText({
      logical: "src/a.ts",
      revision: "r1",
      text: "export function foo() {}\n",
    });
    const structural = [
      {
        logical: "src/a.ts",
        kind: "symbol" as const,
        name: "parsedFoo",
        text: "function parsedFoo",
        startLine: 1,
        endLine: 1,
        revision: "r1",
      },
    ];
    const merged = mergeLexicalWithStructuralSymbols(lexical, structural);
    expect(merged.some((record) => record.kind === "symbol" && record.name === "parsedFoo")).toBe(
      true,
    );
    expect(merged.some((record) => record.kind === "symbol" && record.name === "foo")).toBe(false);
    expect(merged.some((record) => record.kind === "chunk")).toBe(true);
  });

  test("build report counts structural use when symbols are attached", () => {
    const built = buildIndexGeneration(
      {
        sources: [
          {
            logical: "obscure.ts",
            revision: "r1",
            text: `${"x".repeat(80)}\n`,
            structuralSymbols: [
              {
                logical: "obscure.ts",
                kind: "symbol",
                name: "fromParser",
                text: "fromParser",
                startLine: 1,
                endLine: 1,
                revision: "r1",
              },
            ],
          },
        ],
      },
      "gen-struct",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.value.structuralParsingUsed).toBe(1);
    expect(built.value.structuralParsingSkipped).toBe(0);
    expect(
      built.value.generation.records.some(
        (record) => record.kind === "symbol" && record.name === "fromParser",
      ),
    ).toBe(true);
  });
});
