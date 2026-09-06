import { describe, expect, test } from "bun:test";

import { parsePdfReadRequest, pdfReadLimits } from "./pdf-read.ts";

describe("PDF read domain contracts", () => {
  test("normalizes explicit page ranges and query selection", () => {
    expect(
      parsePdfReadRequest({
        path: "report.pdf",
        mode: "pages",
        pages: [{ start: 1, end: 2 }],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        path: "report.pdf",
        mode: "pages",
        pages: [{ start: 1, end: 2 }],
        query: null,
      },
    });
    expect(
      parsePdfReadRequest({
        path: "report.pdf",
        mode: "query",
        query: "revenue",
      }),
    ).toMatchObject({
      ok: true,
      value: { mode: "query", pages: [], query: "revenue" },
    });
  });

  test("rejects implicit whole-document requests and overlapping ranges", () => {
    expect(parsePdfReadRequest({ path: "report.pdf", mode: "pages" })).toEqual({
      ok: false,
      error: { code: "malformed-request", field: "pages" },
    });
    expect(
      parsePdfReadRequest({
        path: "report.pdf",
        mode: "pages",
        pages: [
          { start: 1, end: 2 },
          { start: 2, end: 3 },
        ],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "pages" } });
    expect(
      parsePdfReadRequest({
        path: "report.pdf",
        mode: "query",
        query: "revenue",
        pages: [{ start: 1, end: 1 }],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "mode" } });
  });

  test("rejects budgets that exceed safe maxima or contradict each other", () => {
    expect(pdfReadLimits({ maxPages: 129 })).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxPages" },
    });
    expect(
      pdfReadLimits({
        maxOutputBytes: 1,
        maxPageOutputBytes: 2,
      }),
    ).toMatchObject({
      ok: true,
      value: { maxOutputBytes: 1, maxPageOutputBytes: 2 },
    });
  });
});
