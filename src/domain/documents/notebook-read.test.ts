import { describe, expect, test } from "bun:test";

import { notebookReadLimits, parseNotebookReadRequest } from "./notebook-read.ts";

describe("notebook read domain contracts", () => {
  test("normalizes bounded selection modes", () => {
    expect(
      parseNotebookReadRequest({
        path: "analysis.ipynb",
        mode: "ids",
        ids: ["cell-a"],
      }),
    ).toEqual({
      ok: true,
      value: {
        path: "analysis.ipynb",
        mode: "ids",
        indices: [],
        ids: ["cell-a"],
        range: null,
        limits: {
          maxSourceBytes: 256 * 1024,
          maxCells: 32,
          maxOutputs: 32,
          maxAttachments: 16,
          maxOutputBytes: 16 * 1024,
          maxMetadataBytes: 8 * 1024,
          maxCellSourceBytes: 32 * 1024,
          maxMimeTypes: 8,
        },
      },
    });
    expect(
      parseNotebookReadRequest({
        path: "analysis.ipynb",
        mode: "range",
        range: { start: 1, end: 3 },
      }),
    ).toMatchObject({
      ok: true,
      value: { mode: "range", range: { start: 1, end: 3 } },
    });
  });

  test("rejects fields that do not belong to the selected mode", () => {
    expect(
      parseNotebookReadRequest({
        path: "analysis.ipynb",
        mode: "all",
        ids: ["cell-a"],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "mode" } });
    expect(
      parseNotebookReadRequest({
        path: "analysis.ipynb",
        mode: "range",
        range: { start: 4, end: 2 },
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "range" } });
    expect(
      parseNotebookReadRequest({
        path: "analysis.ipynb",
        mode: "ids",
        ids: ["cell-a", "cell-a"],
      }),
    ).toEqual({ ok: false, error: { code: "malformed-request", field: "ids" } });
  });

  test("rejects malformed and over-limit budgets", () => {
    expect(notebookReadLimits({ maxOutputBytes: 0 })).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxOutputBytes" },
    });
    expect(notebookReadLimits({ maxCells: 129 })).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxCells" },
    });
  });
});
