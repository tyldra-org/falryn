/**
 * Application boundary for the bounded notebook reader (#494).
 *
 * Notebook JSON is read only through the injected workspace reader. This
 * module never evaluates cells, starts a kernel, or treats stored output as
 * current computation.
 */

import {
  assertNever,
  type LocalPath,
  MAX_NOTEBOOK_ATTACHMENT_NAME_LENGTH,
  type NormalizedNotebookReadRequest,
  type NotebookAttachment,
  type NotebookCell,
  type NotebookCellCoordinate,
  type NotebookCellRange,
  type NotebookDiagnostic,
  type NotebookDiagnosticCode,
  type NotebookDocument,
  type NotebookEmptyReason,
  type NotebookJsonValue,
  type NotebookOmission,
  type NotebookOutput,
  type NotebookOutputCoordinate,
  type NotebookOutputKind,
  type NotebookOutputPart,
  type NotebookPreviewKind,
  type NotebookRead,
  type NotebookReadError,
  type NotebookReadLimits,
  type NotebookStopReason,
  parseNotebookReadRequest,
  type Result,
} from "../domain/index.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

const SUPPORTED_NOTEBOOK_FORMAT_MAJOR = 4;
const NOTEBOOK_MIME_TYPES = [
  "application/json",
  "application/javascript",
  "application/pdf",
  "application/vnd.jupyter.widget-state+json",
  "application/vnd.jupyter.widget-view+json",
  "application/vnd.plotly.v1+json",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "text/html",
  "text/latex",
  "text/markdown",
  "text/plain",
] as const;

type JsonRecord = { readonly [key: string]: unknown };

type ParsedNotebook = {
  readonly format: {
    readonly major: number;
    readonly minor: number;
  };
  readonly metadata: JsonRecord;
  readonly cells: readonly unknown[];
};

type RenderBudget = {
  remainingBytes: number;
  remainingOutputs: number;
  remainingAttachments: number;
  exhausted: boolean;
};

type RenderState = {
  readonly budget: RenderBudget;
  readonly limits: NotebookReadLimits;
  readonly omissions: NotebookOmission[];
  readonly recoveryRanges: NotebookCellRange[];
  stopReason: NotebookStopReason | null;
};

type RenderedText = {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
};

type SelectedCells = {
  readonly indexes: readonly number[];
  readonly omissions: readonly NotebookOmission[];
  readonly recoveryRanges: readonly NotebookCellRange[];
  readonly emptyReason: NotebookEmptyReason | null;
};

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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): RenderedText {
  const sourceBytes = byteLength(value);
  if (sourceBytes <= maxBytes) {
    return { value, truncated: false, omittedBytes: 0 };
  }
  const encoded = Buffer.from(value, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = Math.max(0, maxBytes); length > 0; length -= 1) {
    try {
      const truncated = decoder.decode(encoded.subarray(0, length));
      return {
        value: truncated,
        truncated: true,
        omittedBytes: sourceBytes - byteLength(truncated),
      };
    } catch {}
  }
  return { value: "", truncated: true, omittedBytes: sourceBytes };
}

function renderText(value: string, budget: RenderBudget, maxItemBytes: number): RenderedText {
  const allowedBytes = Math.min(maxItemBytes, budget.remainingBytes);
  const rendered = truncateUtf8(value, allowedBytes);
  budget.remainingBytes -= byteLength(rendered.value);
  if (budget.remainingBytes === 0) {
    budget.exhausted = true;
  }
  return rendered;
}

function safeJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function toNotebookJsonValue(value: unknown, depth = 0): NotebookJsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (depth > 32) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toNotebookJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, NotebookJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = toNotebookJsonValue(value[key], depth + 1);
    }
    return result;
  }
  return null;
}

function textField(value: unknown): { readonly value: string; readonly valid: boolean } {
  if (typeof value === "string") {
    return { value, valid: true };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { value: value.join(""), valid: true };
  }
  return { value: "", valid: false };
}

function coordinate(
  cellIndex: number,
  cellId: string | null,
  outputIndex: number | null = null,
  attachmentName: string | null = null,
  mimeType: string | null = null,
): NotebookDiagnostic["coordinate"] {
  return { cellIndex, cellId, outputIndex, attachmentName, mimeType };
}

function diagnostic(
  code: NotebookDiagnosticCode,
  cellIndex: number,
  cellId: string | null,
  outputIndex: number | null = null,
  attachmentName: string | null = null,
  mimeType: string | null = null,
): NotebookDiagnostic {
  return {
    code,
    coordinate: coordinate(cellIndex, cellId, outputIndex, attachmentName, mimeType),
  };
}

function omission(
  kind: NotebookOmission["kind"],
  count: number,
  range: NotebookCellRange | null,
  reason: NotebookOmission["reason"],
): NotebookOmission | null {
  return count > 0 ? { kind, count, range, reason } : null;
}

function addOmission(
  state: RenderState | NotebookOmission[],
  kind: NotebookOmission["kind"],
  count: number,
  range: NotebookCellRange | null,
  reason: NotebookOmission["reason"],
): void {
  const value = omission(kind, count, range, reason);
  if (value !== null) {
    const omissions = Array.isArray(state) ? state : state.omissions;
    omissions.push(value);
  }
}

function rangesForIndexes(indexes: readonly number[]): readonly NotebookCellRange[] {
  const ordered = [...new Set(indexes)].sort((left, right) => left - right);
  const ranges: NotebookCellRange[] = [];
  for (const index of ordered) {
    const previous = ranges.at(-1);
    if (previous === undefined || index > previous.end + 1) {
      ranges.push({ start: index, end: index });
      continue;
    }
    ranges[ranges.length - 1] = { ...previous, end: index };
  }
  return ranges;
}

function cellId(value: unknown): string | null {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    hasNoControlCharacters(value) &&
    value.trim() !== ""
  ) {
    return value;
  }
  return null;
}

function cellIdAt(value: unknown): string | null {
  return isRecord(value) ? cellId(value.id) : null;
}

function selectCells(
  request: NormalizedNotebookReadRequest,
  rawCells: readonly unknown[],
): SelectedCells {
  const total = rawCells.length;
  let requested: number[] = [];
  let missingSelections = 0;
  let emptyReason: NotebookEmptyReason | null = null;

  switch (request.mode) {
    case "all":
      requested = Array.from({ length: total }, (_, index) => index);
      break;
    case "indices":
      requested = request.indices.filter((index) => index < total);
      missingSelections = request.indices.length - requested.length;
      emptyReason = requested.length === 0 ? "no-selected-cells" : null;
      break;
    case "ids": {
      const indexesById = new Map<string, number[]>();
      rawCells.forEach((cell, index) => {
        const id = cellIdAt(cell);
        if (id === null) {
          return;
        }
        const indexes = indexesById.get(id) ?? [];
        indexes.push(index);
        indexesById.set(id, indexes);
      });
      for (const id of request.ids) {
        const indexes = indexesById.get(id);
        if (indexes === undefined) {
          missingSelections += 1;
          continue;
        }
        requested.push(...indexes);
      }
      emptyReason = requested.length === 0 ? "no-matching-ids" : null;
      break;
    }
    case "range": {
      const range = request.range;
      if (range === null) {
        return { indexes: [], omissions: [], recoveryRanges: [], emptyReason: "no-selected-cells" };
      }
      const end = Math.min(range.end, Math.max(-1, total - 1));
      requested =
        end < range.start
          ? []
          : Array.from({ length: end - range.start + 1 }, (_, offset) => range.start + offset);
      emptyReason = requested.length === 0 ? "no-selected-cells" : null;
      break;
    }
    default:
      return assertNever(request.mode, "unhandled notebook selection mode");
  }

  const ordered = [...new Set(requested)].sort((left, right) => left - right);
  const omissions: NotebookOmission[] = [];
  const recoveryRanges: NotebookCellRange[] = [];
  addOmission(omissions, "selection", missingSelections, null, "not-found");

  const admitted = ordered.slice(0, request.limits.maxCells);
  const capped = ordered.slice(admitted.length);
  for (const range of rangesForIndexes(capped)) {
    addOmission(omissions, "cells", range.end - range.start + 1, range, "budget");
    recoveryRanges.push(range);
  }
  if (total === 0) {
    emptyReason = "empty-notebook";
  } else if (admitted.length === 0 && emptyReason === null) {
    emptyReason = "no-selected-cells";
  }

  return { indexes: admitted, omissions, recoveryRanges, emptyReason };
}

function previewKindForMime(mimeType: string, value: unknown): NotebookPreviewKind {
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
    return "binary";
  }
  if (mimeType === "application/json" || mimeType.endsWith("+json") || typeof value === "object") {
    return "json";
  }
  return "text";
}

function previewText(value: unknown, mimeType: string): string {
  if (
    typeof value === "string" &&
    (mimeType.startsWith("text/") || mimeType === "application/javascript")
  ) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    mimeType.startsWith("text/")
  ) {
    return value.join("");
  }
  return safeJsonStringify(value);
}

function isKnownMimeType(mimeType: string): boolean {
  return (NOTEBOOK_MIME_TYPES as readonly string[]).includes(mimeType);
}

function isWidgetMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/vnd.jupyter.widget-view+json" ||
    mimeType === "application/vnd.jupyter.widget-state+json"
  );
}

function metadataProjection(metadata: JsonRecord, maxBytes: number): NotebookDocument["metadata"] {
  const value = toNotebookJsonValue(metadata);
  const rendered = truncateUtf8(safeJsonStringify(value), maxBytes);
  return {
    value: rendered.truncated ? null : value,
    preview: rendered.value,
    truncated: rendered.truncated,
  };
}

function renderMimePart(
  value: unknown,
  mimeType: string,
  cellIndex: number,
  cellIdValue: string | null,
  outputIndex: number,
  state: RenderState,
): { readonly part: NotebookOutputPart; readonly diagnostic: NotebookDiagnostic | null } {
  const preview = renderText(
    previewText(value, mimeType),
    state.budget,
    state.budget.remainingBytes,
  );
  if (preview.omittedBytes > 0) {
    addOmission(
      state,
      "bytes",
      preview.omittedBytes,
      { start: cellIndex, end: cellIndex },
      "budget",
    );
  }
  if (state.budget.exhausted) {
    state.stopReason = "budget";
  }
  const outputDiagnostic = preview.truncated
    ? diagnostic("huge-output", cellIndex, cellIdValue, outputIndex, null, mimeType)
    : null;
  const part: NotebookOutputPart = {
    coordinate: {
      cellIndex,
      cellId: cellIdValue,
      outputIndex,
      mimeType,
    },
    preview: preview.value,
    previewKind: previewKindForMime(mimeType, value),
    truncated: preview.truncated,
  };
  return { part, diagnostic: outputDiagnostic };
}

function outputData(value: unknown): readonly [readonly [string, unknown][], boolean] {
  if (!isRecord(value)) {
    return [[], false];
  }
  return [
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
    true,
  ];
}

function renderOutput(
  value: unknown,
  cellIndex: number,
  cellIdValue: string | null,
  outputIndex: number,
  state: RenderState,
): NotebookOutput {
  const outputCoordinate: NotebookOutputCoordinate = {
    cellIndex,
    cellId: cellIdValue,
    outputIndex,
  };
  const outputDiagnostics: NotebookDiagnostic[] = [];
  if (!isRecord(value)) {
    outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
    return {
      coordinate: outputCoordinate,
      kind: "unknown",
      executionCount: null,
      freshness: "stored",
      parts: [],
      truncated: false,
      diagnostics: outputDiagnostics,
    };
  }

  const outputType = typeof value.output_type === "string" ? value.output_type : null;
  let kind: NotebookOutputKind = "unknown";
  if (outputType === "stream") {
    kind = "stream";
  } else if (outputType === "execute_result") {
    kind = "execute-result";
  } else if (outputType === "display_data") {
    kind = "display-data";
  } else if (outputType === "error") {
    kind = "error";
  } else if (outputType === null) {
    outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
  } else {
    outputDiagnostics.push(diagnostic("unknown-output-type", cellIndex, cellIdValue, outputIndex));
  }

  let executionCount: number | null = null;
  if (value.execution_count !== undefined && value.execution_count !== null) {
    if (
      typeof value.execution_count === "number" &&
      Number.isInteger(value.execution_count) &&
      value.execution_count >= 0
    ) {
      executionCount = value.execution_count;
    } else {
      outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
    }
  }

  const parts: NotebookOutputPart[] = [];
  if (kind === "stream") {
    const text = textField(value.text);
    if (!text.valid) {
      outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
    } else {
      const rendered = renderMimePart(
        text.value,
        "text/plain",
        cellIndex,
        cellIdValue,
        outputIndex,
        state,
      );
      parts.push(rendered.part);
      if (rendered.diagnostic !== null) {
        outputDiagnostics.push(rendered.diagnostic);
      }
    }
  } else if (kind === "error") {
    const traceback = textField(value.traceback);
    const name = typeof value.ename === "string" ? value.ename : "";
    const message = typeof value.evalue === "string" ? value.evalue : "";
    const text = traceback.valid
      ? traceback.value
      : [name, message].filter((item) => item !== "").join(": ");
    if (!traceback.valid && text === "") {
      outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
    } else {
      const rendered = renderMimePart(
        text,
        "text/plain",
        cellIndex,
        cellIdValue,
        outputIndex,
        state,
      );
      parts.push(rendered.part);
      if (rendered.diagnostic !== null) {
        outputDiagnostics.push(rendered.diagnostic);
      }
    }
  } else if (kind === "execute-result" || kind === "display-data") {
    const [entries, valid] = outputData(value.data);
    if (!valid) {
      outputDiagnostics.push(diagnostic("malformed-output", cellIndex, cellIdValue, outputIndex));
    } else {
      if (entries.length > 1) {
        outputDiagnostics.push(diagnostic("display-bundle", cellIndex, cellIdValue, outputIndex));
      }
      const admitted = entries.slice(0, state.limits.maxMimeTypes);
      for (const [mimeType, mimeValue] of admitted) {
        const rendered = renderMimePart(
          mimeValue,
          mimeType,
          cellIndex,
          cellIdValue,
          outputIndex,
          state,
        );
        parts.push(rendered.part);
        if (!isKnownMimeType(mimeType)) {
          outputDiagnostics.push(
            diagnostic("unknown-mime-type", cellIndex, cellIdValue, outputIndex, null, mimeType),
          );
        }
        if (isWidgetMimeType(mimeType)) {
          outputDiagnostics.push(
            diagnostic("widget", cellIndex, cellIdValue, outputIndex, null, mimeType),
          );
        }
        if (rendered.diagnostic !== null) {
          outputDiagnostics.push(rendered.diagnostic);
        }
      }
      if (entries.length > admitted.length) {
        addOmission(
          state,
          "outputs",
          entries.length - admitted.length,
          { start: cellIndex, end: cellIndex },
          "budget",
        );
      }
    }
  }

  return {
    coordinate: outputCoordinate,
    kind,
    executionCount,
    freshness: "stored",
    parts,
    truncated: outputDiagnostics.some((item) => item.code === "huge-output"),
    diagnostics: outputDiagnostics,
  };
}

function renderAttachment(
  value: unknown,
  cellIndex: number,
  cellIdValue: string | null,
  attachmentName: string,
  mimeType: string,
  state: RenderState,
): NotebookAttachment {
  const attachmentCoordinate = {
    cellIndex,
    cellId: cellIdValue,
    attachmentName,
  };
  const diagnostics: NotebookDiagnostic[] = [];
  if (!isKnownMimeType(mimeType)) {
    diagnostics.push(
      diagnostic("unknown-mime-type", cellIndex, cellIdValue, null, attachmentName, mimeType),
    );
  }
  if (state.budget.remainingAttachments <= 0) {
    diagnostics.push(
      diagnostic("huge-attachment", cellIndex, cellIdValue, null, attachmentName, mimeType),
    );
    addOmission(state, "attachments", 1, { start: cellIndex, end: cellIndex }, "budget");
    state.stopReason = "budget";
    return {
      coordinate: attachmentCoordinate,
      mimeType,
      preview: "",
      previewKind: previewKindForMime(mimeType, value),
      truncated: true,
      diagnostics,
    };
  }
  state.budget.remainingAttachments -= 1;
  const preview = renderText(
    previewText(value, mimeType),
    state.budget,
    state.limits.maxOutputBytes,
  );
  if (preview.omittedBytes > 0) {
    diagnostics.push(
      diagnostic("huge-attachment", cellIndex, cellIdValue, null, attachmentName, mimeType),
    );
    addOmission(
      state,
      "bytes",
      preview.omittedBytes,
      { start: cellIndex, end: cellIndex },
      "budget",
    );
  }
  if (state.budget.exhausted) {
    state.stopReason = "budget";
  }
  if (preview.truncated && !diagnostics.some((item) => item.code === "huge-attachment")) {
    diagnostics.push(
      diagnostic("huge-attachment", cellIndex, cellIdValue, null, attachmentName, mimeType),
    );
  }
  return {
    coordinate: attachmentCoordinate,
    mimeType,
    preview: preview.value,
    previewKind: previewKindForMime(mimeType, value),
    truncated: preview.truncated,
    diagnostics,
  };
}

function renderCell(value: unknown, cellIndex: number, state: RenderState): NotebookCell {
  const rawCell = isRecord(value) ? value : {};
  const cellDiagnostics: NotebookDiagnostic[] = [];
  if (!isRecord(value)) {
    cellDiagnostics.push(diagnostic("malformed-cell", cellIndex, null));
  }

  const rawId = rawCell.id;
  const id = cellId(rawId);
  const stableId = id !== null;
  if (rawId !== undefined && id === null) {
    cellDiagnostics.push(diagnostic("malformed-cell", cellIndex, null));
  }
  if (!stableId) {
    cellDiagnostics.push(diagnostic("missing-id", cellIndex, null));
  }

  const rawType = typeof rawCell.cell_type === "string" ? rawCell.cell_type : null;
  const type =
    rawType === "code" || rawType === "markdown" || rawType === "raw" ? rawType : "unknown";
  if (rawType === null) {
    cellDiagnostics.push(diagnostic("malformed-cell", cellIndex, id));
  } else if (type === "unknown") {
    cellDiagnostics.push(diagnostic("unsupported-cell-type", cellIndex, id));
  }

  const source = textField(rawCell.source);
  if (!source.valid) {
    cellDiagnostics.push(diagnostic("malformed-source", cellIndex, id));
  }
  const renderedSource = renderText(source.value, state.budget, state.limits.maxCellSourceBytes);
  if (renderedSource.omittedBytes > 0) {
    addOmission(
      state,
      "bytes",
      renderedSource.omittedBytes,
      { start: cellIndex, end: cellIndex },
      "budget",
    );
  }
  if (state.budget.exhausted) {
    state.stopReason = "budget";
  }

  let executionCount: number | null = null;
  if (rawCell.execution_count !== undefined && rawCell.execution_count !== null) {
    if (
      typeof rawCell.execution_count === "number" &&
      Number.isInteger(rawCell.execution_count) &&
      rawCell.execution_count >= 0
    ) {
      executionCount = rawCell.execution_count;
    } else {
      cellDiagnostics.push(diagnostic("malformed-execution-count", cellIndex, id));
    }
  }

  const outputs: NotebookOutput[] = [];
  if (rawCell.outputs !== undefined && !Array.isArray(rawCell.outputs)) {
    cellDiagnostics.push(diagnostic("malformed-output", cellIndex, id));
  }
  const rawOutputs = Array.isArray(rawCell.outputs) ? rawCell.outputs : [];
  for (let outputIndex = 0; outputIndex < rawOutputs.length; outputIndex += 1) {
    if (state.stopReason === "budget") {
      addOmission(
        state,
        "outputs",
        rawOutputs.length - outputIndex,
        { start: cellIndex, end: cellIndex },
        "budget",
      );
      break;
    }
    if (state.budget.remainingOutputs <= 0) {
      addOmission(
        state,
        "outputs",
        rawOutputs.length - outputIndex,
        { start: cellIndex, end: cellIndex },
        "budget",
      );
      state.stopReason = "budget";
      break;
    }
    state.budget.remainingOutputs -= 1;
    outputs.push(renderOutput(rawOutputs[outputIndex], cellIndex, id, outputIndex, state));
  }

  const attachments: NotebookAttachment[] = [];
  if (rawCell.attachments !== undefined && !isRecord(rawCell.attachments)) {
    cellDiagnostics.push(diagnostic("malformed-attachment", cellIndex, id));
  }
  const rawAttachments = isRecord(rawCell.attachments) ? rawCell.attachments : {};
  for (const attachmentName of Object.keys(rawAttachments).sort()) {
    const rawAttachment = rawAttachments[attachmentName];
    if (attachmentName.length > MAX_NOTEBOOK_ATTACHMENT_NAME_LENGTH) {
      cellDiagnostics.push(diagnostic("malformed-attachment", cellIndex, id, null, attachmentName));
      addOmission(state, "attachments", 1, { start: cellIndex, end: cellIndex }, "malformed");
      continue;
    }
    if (!isRecord(rawAttachment)) {
      cellDiagnostics.push(diagnostic("malformed-attachment", cellIndex, id, null, attachmentName));
      continue;
    }
    for (const mimeType of Object.keys(rawAttachment).sort()) {
      if (state.stopReason === "budget") {
        addOmission(state, "attachments", 1, { start: cellIndex, end: cellIndex }, "budget");
        break;
      }
      if (state.budget.remainingAttachments <= 0) {
        addOmission(state, "attachments", 1, { start: cellIndex, end: cellIndex }, "budget");
        state.stopReason = "budget";
        break;
      }
      attachments.push(
        renderAttachment(rawAttachment[mimeType], cellIndex, id, attachmentName, mimeType, state),
      );
    }
    if (state.stopReason === "budget") {
      break;
    }
  }

  const coordinate: NotebookCellCoordinate = { cellIndex, cellId: id };
  return {
    coordinate,
    type,
    stableId,
    source: renderedSource.value,
    sourceTruncated: renderedSource.truncated,
    executionCount,
    outputs,
    attachments,
    diagnostics: cellDiagnostics,
  };
}

function parseNotebookJson(text: string): Result<ParsedNotebook, NotebookReadError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: { code: "malformed-json" } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "malformed-notebook", field: "cells" } };
  }

  const major = parsed.nbformat;
  const minor = parsed.nbformat_minor;
  if (typeof major !== "number" || !Number.isInteger(major) || major < 0) {
    return { ok: false, error: { code: "malformed-notebook", field: "nbformat" } };
  }
  if (typeof minor !== "number" || !Number.isInteger(minor) || minor < 0) {
    return { ok: false, error: { code: "malformed-notebook", field: "nbformat_minor" } };
  }
  if (major !== SUPPORTED_NOTEBOOK_FORMAT_MAJOR) {
    return { ok: false, error: { code: "unsupported-version", major, minor } };
  }
  if (!isRecord(parsed.metadata)) {
    return { ok: false, error: { code: "malformed-notebook", field: "metadata" } };
  }
  if (!Array.isArray(parsed.cells)) {
    return { ok: false, error: { code: "malformed-notebook", field: "cells" } };
  }
  return {
    ok: true,
    value: {
      format: { major, minor },
      metadata: parsed.metadata,
      cells: parsed.cells,
    },
  };
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
