import { describe, expect, test } from "bun:test";

import {
  compactDocumentFamily,
  compactDocumentLimits,
  extractCompactDocumentHeadings,
  parseCompactDocumentReadRequest,
} from "./compact-document-read.ts";

describe("compact document domain contracts", () => {
  test("normalizes bounded modes and explicit ranges", () => {
    expect(
      parseCompactDocumentReadRequest({
        path: "README.md",
        mode: "ranges",
        ranges: [{ start: 2, end: 4, kind: "symbol", label: "Child" }],
      }),
    ).toEqual({
      ok: true,
      value: {
        path: "README.md",
        mode: "ranges",
        ranges: [{ start: 2, end: 4, kind: "symbol", label: "Child" }],
        headLines: 32,
        tailLines: 32,
        query: null,
        limits: {
          maxSourceBytes: 256 * 1024,
          maxOutputBytes: 16 * 1024,
          maxOutputLines: 256,
          maxSpans: 32,
          maxContextLines: 1,
        },
      },
    });
  });

  test("rejects mode-specific fields that would be silently ignored", () => {
    expect(
      parseCompactDocumentReadRequest({
        path: "README.md",
        mode: "outline",
        ranges: [{ start: 1, end: 1 }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "ranges" } });
    expect(
      parseCompactDocumentReadRequest({
        path: "README.md",
        mode: "relevant",
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "query" } });
    expect(
      parseCompactDocumentReadRequest({
        path: "README.md",
        mode: "head-tail",
        headLines: 0,
        tailLines: 0,
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "mode" } });
  });

  test("rejects malformed and over-limit budgets", () => {
    expect(compactDocumentLimits({ maxOutputBytes: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxOutputBytes" },
    });
    expect(compactDocumentLimits({ maxOutputBytes: 128 * 1024 + 1 })).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxOutputBytes" },
    });
  });

  test("extracts stable Markdown heading paths", () => {
    const headings = extractCompactDocumentHeadings(
      [
        { number: 1, text: "# Root" },
        { number: 2, text: "intro" },
        { number: 3, text: "## Child" },
        { number: 4, text: "body" },
        { number: 5, text: "### Leaf ###" },
      ],
      "markdown",
    );
    expect(headings).toEqual([
      {
        kind: "heading",
        level: 1,
        title: "Root",
        range: { start: 1, end: 1 },
        headingPath: ["Root"],
        symbolPath: [],
      },
      {
        kind: "heading",
        level: 2,
        title: "Child",
        range: { start: 3, end: 3 },
        headingPath: ["Root", "Child"],
        symbolPath: [],
      },
      {
        kind: "heading",
        level: 3,
        title: "Leaf",
        range: { start: 5, end: 5 },
        headingPath: ["Root", "Child", "Leaf"],
        symbolPath: [],
      },
    ]);
  });

  test("extracts source symbols and configuration sections without a provider", () => {
    const source = extractCompactDocumentHeadings(
      [
        { number: 1, text: "export class App {" },
        { number: 2, text: "  function run() {}" },
      ],
      "source",
    );
    expect(source.map((heading) => heading.symbolPath)).toEqual([["App"], ["App", "run"]]);

    const configuration = extractCompactDocumentHeadings(
      [
        { number: 1, text: "[server]" },
        { number: 2, text: "port = 3000" },
      ],
      "configuration",
    );
    expect(configuration[0]?.headingPath).toEqual(["server"]);
  });

  test("classifies supported document families deterministically", () => {
    expect(compactDocumentFamily("README.md")).toBe("markdown");
    expect(compactDocumentFamily("config/settings.toml")).toBe("configuration");
    expect(compactDocumentFamily("logs/app.log")).toBe("log");
    expect(compactDocumentFamily("src/main.ts")).toBe("source");
    expect(compactDocumentFamily("notes.txt")).toBe("text");
  });
});
