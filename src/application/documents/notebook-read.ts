/**
 * Application boundary for the bounded notebook reader (#494).
 *
 * Notebook JSON is read only through the injected workspace reader. This
 * module never evaluates cells, starts a kernel, or treats stored output as
 * current computation.
 */

import {
  type NormalizedNotebookReadRequest,
  type NotebookCell,
  type NotebookCellRange,
  type NotebookDocument,
  type NotebookEmptyReason,
  type NotebookOmission,
  type NotebookRead,
  type NotebookReadError,
  type NotebookStopReason,
  parseNotebookReadRequest,
} from "../../domain/documents/index.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import type { WorkspaceReader } from "../workspace/workspace-read.ts";
import type { ParsedNotebook, RenderState } from "./notebook-read/contracts.ts";
import { parseNotebookJson } from "./notebook-read/parsing.ts";
import {
  addOmission,
  metadataProjection,
  rangesForIndexes,
  renderCell,
  selectCells,
} from "./notebook-read/rendering.ts";

export type NotebookReader = {
  read(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: NotebookRead }
    | { readonly ok: false; readonly error: NotebookReadError }
  >;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function documentIdentity(
  requestPath: string,
  bound: NotebookDocument["bound"],
  parsed: ParsedNotebook,
  byteLengthValue: number,
  newline: NotebookDocument["newline"],
  metadataLimit: number,
): NotebookDocument {
  return {
    requested: requestPath,
    bound,
    format: parsed.format,
    byteLength: byteLengthValue,
    newline,
    metadata: metadataProjection(parsed.metadata, metadataLimit),
  };
}

function emptyResult(
  request: NormalizedNotebookReadRequest,
  document: NotebookDocument,
  omissions: readonly NotebookOmission[],
  recoveryRanges: readonly NotebookCellRange[],
  emptyReason: NotebookEmptyReason,
  stopReason: NotebookStopReason | null,
): NotebookRead {
  return {
    capability: "read_notebook",
    projection: "notebook",
    complete: false,
    status: "empty",
    mode: request.mode,
    document,
    cells: [],
    omissions,
    recoveryRanges,
    stopReason,
    emptyReason,
  };
}

function hasDiagnostics(cells: readonly NotebookCell[]): boolean {
  return cells.some(
    (cell) =>
      cell.diagnostics.length > 0 ||
      cell.outputs.some((output) => output.diagnostics.length > 0) ||
      cell.attachments.some((attachment) => attachment.diagnostics.length > 0),
  );
}

async function readNotebook(
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: NotebookRead }
  | { readonly ok: false; readonly error: NotebookReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsedRequest = parseNotebookReadRequest(request);
  if (!parsedRequest.ok) {
    return parsedRequest;
  }
  if (!parsedRequest.value.path.toLowerCase().endsWith(".ipynb")) {
    return { ok: false, error: { code: "not-notebook" } };
  }

  const source = await workspaceReader.read(
    root,
    parsedRequest.value.path,
    undefined,
    { maxFileBytes: parsedRequest.value.limits.maxSourceBytes },
    signal,
  );
  if (!source.ok) {
    return { ok: false, error: source.error };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }

  const sourceText = source.value.lines.map((line) => line.text).join("\n");
  const parsedNotebook = parseNotebookJson(sourceText);
  if (!parsedNotebook.ok) {
    return parsedNotebook;
  }
  const document = documentIdentity(
    parsedRequest.value.path,
    source.value.bound,
    parsedNotebook.value,
    source.value.byteLength,
    source.value.newline,
    parsedRequest.value.limits.maxMetadataBytes,
  );
  const selected = selectCells(parsedRequest.value, parsedNotebook.value.cells);
  const omissions: NotebookOmission[] = [...selected.omissions];
  const recoveryRanges: NotebookCellRange[] = [...selected.recoveryRanges];
  if (document.metadata.truncated) {
    addOmission(omissions, "metadata", 1, null, "budget");
  }

  if (selected.indexes.length === 0) {
    return {
      ok: true,
      value: emptyResult(
        parsedRequest.value,
        document,
        omissions,
        recoveryRanges,
        selected.emptyReason ?? "no-selected-cells",
        null,
      ),
    };
  }

  const state: RenderState = {
    budget: {
      remainingBytes: parsedRequest.value.limits.maxOutputBytes,
      remainingOutputs: parsedRequest.value.limits.maxOutputs,
      remainingAttachments: parsedRequest.value.limits.maxAttachments,
      exhausted: false,
    },
    limits: parsedRequest.value.limits,
    omissions,
    recoveryRanges,
    stopReason: null,
  };
  const cells: NotebookCell[] = [];
  for (let position = 0; position < selected.indexes.length; position += 1) {
    if (isAborted(signal)) {
      state.stopReason = "cancelled";
      const remaining = selected.indexes.slice(position);
      for (const range of rangesForIndexes(remaining)) {
        addOmission(state, "cells", range.end - range.start + 1, range, "budget");
        state.recoveryRanges.push(range);
      }
      break;
    }
    if (state.stopReason === "budget") {
      const remaining = selected.indexes.slice(position);
      for (const range of rangesForIndexes(remaining)) {
        addOmission(state, "cells", range.end - range.start + 1, range, "budget");
        state.recoveryRanges.push(range);
      }
      break;
    }
    const index = selected.indexes[position];
    if (index === undefined) {
      continue;
    }
    cells.push(renderCell(parsedNotebook.value.cells[index], index, state));
  }

  if (cells.length === 0) {
    return {
      ok: true,
      value: emptyResult(
        parsedRequest.value,
        document,
        state.omissions,
        state.recoveryRanges,
        selected.emptyReason ?? "no-selected-cells",
        state.stopReason,
      ),
    };
  }
  return {
    ok: true,
    value: {
      capability: "read_notebook",
      projection: "notebook",
      complete: false,
      status:
        state.omissions.length > 0 || state.stopReason !== null || hasDiagnostics(cells)
          ? "partial"
          : "complete",
      mode: parsedRequest.value.mode,
      document,
      cells,
      omissions: state.omissions,
      recoveryRanges: state.recoveryRanges,
      stopReason: state.stopReason,
    },
  };
}

export function createNotebookReader(workspaceReader: WorkspaceReader): NotebookReader {
  return {
    read(root, request, signal) {
      return readNotebook(workspaceReader, root, request, signal);
    },
  };
}
