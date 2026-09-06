import { describe, expect, test } from "bun:test";
import {
  MAX_LANGUAGE_SERVER_COMPLETION_ITEMS,
  parseCompletionResult,
  parseDefinitionResult,
  parseDocumentSymbolsResult,
  parseHover,
  parsePublishDiagnostics,
  parseReferencesResult,
  validateTextDocumentPosition,
} from "./language-server-features.ts";

describe("language-server feature contracts", () => {
  test("validates text document positions", () => {
    expect(
      validateTextDocumentPosition({
        uri: "file:///tmp/a.ts",
        position: { line: 0, character: 1 },
      }),
    ).toBeNull();
    expect(
      validateTextDocumentPosition({
        uri: "relative",
        position: { line: 0, character: 0 },
      }),
    ).toBe("invalid-uri");
    expect(
      validateTextDocumentPosition({
        uri: "file:///tmp/a.ts",
        position: { line: -1, character: 0 },
      }),
    ).toBe("invalid-position");
  });

  test("parses hover, definition, and references", () => {
    expect(parseHover(null)).toEqual({ ok: true, value: null });
    expect(
      parseHover({
        contents: { kind: "markdown", value: "**x**" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      }),
    ).toEqual({
      ok: true,
      value: {
        contents: { kind: "markdown", value: "**x**" },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    });

    expect(
      parseDefinitionResult({
        uri: "file:///tmp/a.ts",
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          uri: "file:///tmp/a.ts",
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        },
      ],
    });

    expect(
      parseReferencesResult([
        {
          uri: "file:///tmp/a.ts",
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
        },
      ]).ok,
    ).toBe(true);
  });

  test("parses document symbols and completion lists", () => {
    const symbols = parseDocumentSymbolsResult([
      {
        name: "Foo",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        children: [],
      },
    ]);
    expect(symbols).toEqual({
      ok: true,
      value: {
        kind: "document",
        symbols: [
          {
            name: "Foo",
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
            children: [],
          },
        ],
      },
    });

    expect(
      parseCompletionResult({
        isIncomplete: true,
        items: [{ label: "console", kind: 3, detail: "log" }],
      }),
    ).toEqual({
      ok: true,
      value: {
        isIncomplete: true,
        items: [{ label: "console", kind: 3, detail: "log" }],
      },
    });

    expect(
      parseCompletionResult(
        Array.from({ length: MAX_LANGUAGE_SERVER_COMPLETION_ITEMS + 1 }, (_, index) => ({
          label: `item${index}`,
        })),
      ),
    ).toEqual({ ok: false, error: "result-too-large" });
  });

  test("parses publishDiagnostics", () => {
    expect(
      parsePublishDiagnostics({
        uri: "file:///tmp/a.ts",
        version: 2,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: "unused",
            severity: 2,
            code: 6133,
            source: "ts",
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        uri: "file:///tmp/a.ts",
        version: 2,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: "unused",
            severity: 2,
            code: 6133,
            source: "ts",
          },
        ],
      },
    });
  });
});
