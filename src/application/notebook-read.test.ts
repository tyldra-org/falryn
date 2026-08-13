import { describe, expect, test } from "bun:test";

import { createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createNotebookReader, type NotebookReader } from "./notebook-read.ts";
import { createWorkspaceReader, type WorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python" },
  },
  cells: [
    {
      cell_type: "code",
      id: "code-a",
      metadata: {},
      execution_count: 3,
      source: ["print('hello')\n"],
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hello\n"] },
        {
          output_type: "display_data",
          data: {
            "application/vnd.jupyter.widget-view+json": { model_id: "widget-a", version_major: 2 },
            "application/x-custom": "custom preview",
            "text/plain": "display preview",
          },
          metadata: {},
        },
      ],
    },
    {
      cell_type: "markdown",
      id: "markdown-a",
      metadata: {},
      source: ["# Result\n"],
      attachments: {
        "plot.png": {
          "image/png": "iVBORw0KGgo=",
        },
      },
    },
    {
      cell_type: "raw",
      metadata: {},
      source: "raw content\n",
    },
    "malformed cell",
  ],
};

function createFileSystem() {
  return createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/analysis.ipynb": {
        kind: "file",
        text: JSON.stringify(notebook),
      },
      "/work/project/malformed.ipynb": { kind: "file", text: "{" },
      "/work/project/v5.ipynb": {
        kind: "file",
        text: JSON.stringify({ nbformat: 5, nbformat_minor: 0, metadata: {}, cells: [] }),
      },
      "/work/project/plain.txt": { kind: "file", text: "not a notebook" },
    },
  });
}

function reader(): NotebookReader {
  return createNotebookReader(createWorkspaceReader(createFileSystem()));
}

describe("createNotebookReader", () => {
  test("returns versioned cells, metadata, outputs, attachments, and visible diagnostics", async () => {
    const result = await reader().read(root, { path: "analysis.ipynb", mode: "all" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected notebook cells");
    }

    expect(result.value.projection).toBe("notebook");
    expect(result.value.complete).toBe(false);
    expect(result.value.document.format).toEqual({ major: 4, minor: 5 });
    expect(result.value.document.metadata.value).toMatchObject({
      kernelspec: { display_name: "Python 3" },
    });
    expect(result.value.cells.map((cell) => cell.coordinate.cellIndex)).toEqual([0, 1, 2, 3]);
    expect(result.value.cells[0]?.executionCount).toBe(3);
    expect(result.value.cells[0]?.outputs[0]?.parts[0]?.preview).toBe("hello\n");
    expect(result.value.cells[0]?.outputs[0]?.freshness).toBe("stored");
    expect(result.value.cells[0]?.outputs[1]?.diagnostics.map((item) => item.code)).toEqual([
      "display-bundle",
      "widget",
      "unknown-mime-type",
    ]);
    expect(result.value.cells[1]?.attachments[0]?.coordinate).toEqual({
      cellIndex: 1,
      cellId: "markdown-a",
      attachmentName: "plot.png",
    });
    expect(result.value.cells[1]?.attachments[0]?.previewKind).toBe("binary");
    expect(result.value.cells[2]?.stableId).toBe(false);
    expect(result.value.cells[2]?.diagnostics.map((item) => item.code)).toContain("missing-id");
    expect(result.value.cells[3]?.diagnostics.map((item) => item.code)).toContain("malformed-cell");
    expect(result.value.status).toBe("partial");
  });

  test("selects cells by stable ID and bounded range without executing them", async () => {
    const notebookReader = reader();
    const byId = await notebookReader.read(root, {
      path: "analysis.ipynb",
      mode: "ids",
      ids: ["markdown-a"],
    });
    expect(byId.ok && byId.value.status !== "empty" ? byId.value.cells : []).toHaveLength(1);
    expect(
      byId.ok && byId.value.status !== "empty" ? byId.value.cells[0]?.coordinate : null,
    ).toEqual({ cellIndex: 1, cellId: "markdown-a" });

    const byRange = await notebookReader.read(root, {
      path: "analysis.ipynb",
      mode: "range",
      range: { start: 0, end: 3 },
      limits: { maxCells: 2 },
    });
    expect(byRange.ok).toBe(true);
    if (!byRange.ok || byRange.value.status === "empty") {
      throw new Error("expected bounded range");
    }
    expect(byRange.value.cells.map((cell) => cell.coordinate.cellIndex)).toEqual([0, 1]);
    expect(byRange.value.omissions).toContainEqual({
      kind: "cells",
      count: 2,
      range: { start: 2, end: 3 },
      reason: "budget",
    });
  });

  test("stops at output budgets while preserving the completed selected cell", async () => {
    const result = await reader().read(root, {
      path: "analysis.ipynb",
      mode: "all",
      limits: { maxOutputBytes: 8 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected partial notebook");
    }
    expect(result.value.stopReason).toBe("budget");
    expect(result.value.cells).toHaveLength(1);
    expect(result.value.cells[0]?.sourceTruncated).toBe(true);
    expect(result.value.recoveryRanges).toContainEqual({ start: 1, end: 3 });
  });

  test("preserves completed cells when cancellation arrives during expansion", async () => {
    const baseReader = createWorkspaceReader(createFileSystem());
    const source = await baseReader.read(root, "analysis.ipynb");
    if (!source.ok) {
      throw new Error("expected fixture");
    }
    const stub: WorkspaceReader = {
      read: async () => source,
      readMany: async () => ({ ok: true, value: { items: [] } }),
    };
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks >= 4;
      },
    } as AbortSignal;
    const result = await createNotebookReader(stub).read(
      root,
      { path: "analysis.ipynb", mode: "all" },
      signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status === "empty") {
      throw new Error("expected cancelled partial notebook");
    }
    expect(result.value.stopReason).toBe("cancelled");
    expect(result.value.cells).toHaveLength(1);
    expect(result.value.recoveryRanges).toContainEqual({ start: 1, end: 3 });
  });

  test("types malformed JSON, unsupported versions, wrong families, and cancellation", async () => {
    const notebookReader = reader();
    expect(await notebookReader.read(root, { path: "malformed.ipynb", mode: "all" })).toEqual({
      ok: false,
      error: { code: "malformed-json" },
    });
    expect(await notebookReader.read(root, { path: "v5.ipynb", mode: "all" })).toEqual({
      ok: false,
      error: { code: "unsupported-version", major: 5, minor: 0 },
    });
    expect(await notebookReader.read(root, { path: "plain.txt", mode: "all" })).toEqual({
      ok: false,
      error: { code: "not-notebook" },
    });
    expect(
      await notebookReader.read(root, { path: "analysis.ipynb", mode: "all" }, AbortSignal.abort()),
    ).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
